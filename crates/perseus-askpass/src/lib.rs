//! How git and ssh ask the user for a password, a passphrase or a yes/no decision.
//!
//! Git (`GIT_ASKPASS`) and ssh (`SSH_ASKPASS`) run a program and read its standard output. That
//! program is `perseus-askpass`. It connects to a tiny server inside the Perseus app over the
//! loopback interface, sends the prompt, waits for the user's answer from the app window and
//! prints it. The server listens on `127.0.0.1` only, and every request must carry a random
//! token that exists only in the environment of the git processes Perseus starts, so no other
//! program can ask the user questions in Perseus's name.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const ENV_PORT: &str = "PERSEUS_ASKPASS_PORT";
pub const ENV_TOKEN: &str = "PERSEUS_ASKPASS_TOKEN";

/// What kind of answer the prompt expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A secret: password, passphrase, token. Typed text is hidden.
    Secret,
    /// A plain value, such as a user name.
    Text,
    /// A yes/no decision, such as trusting an unknown SSH host.
    Confirm,
    /// Information only; no answer is needed.
    Info,
}

/// Decides how to present a prompt from its wording.
pub fn classify(prompt: &str) -> Kind {
    let p = prompt.to_ascii_lowercase();
    if p.contains("(yes/no") || p.contains("[fingerprint]") {
        Kind::Confirm
    } else if p.contains("password")
        || p.contains("passphrase")
        || p.contains("pin")
        || p.contains("token")
    {
        Kind::Secret
    } else {
        Kind::Text
    }
}

/// Prompts are shown to the user, so control characters (which could fake a different dialog in
/// a terminal-like display) are dropped and the length is capped.
pub fn clean_prompt(prompt: &str) -> String {
    prompt
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(1000)
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
struct Wire {
    token: String,
    prompt: String,
    kind: Kind,
}

#[derive(Debug, Serialize, Deserialize)]
struct Reply {
    /// `None` means the user cancelled.
    answer: Option<String>,
}

const MAX_LINE: u64 = 16 * 1024;

fn read_line(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut line = String::new();
    BufReader::new(stream.take(MAX_LINE)).read_line(&mut line)?;
    Ok(line)
}

/// Client side (used by the `perseus-askpass` program): asks the app and returns the answer, or
/// `None` when the user cancelled.
pub fn ask(port: u16, token: &str, prompt: &str, kind: Kind) -> Result<Option<String>, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    // Waiting for a person: generous, but not forever.
    stream
        .set_read_timeout(Some(Duration::from_secs(15 * 60)))
        .map_err(|e| e.to_string())?;
    let wire = Wire {
        token: token.to_string(),
        prompt: clean_prompt(prompt),
        kind,
    };
    let mut msg = serde_json::to_string(&wire).map_err(|e| e.to_string())?;
    msg.push('\n');
    stream
        .write_all(msg.as_bytes())
        .map_err(|e| e.to_string())?;
    let line = read_line(&mut stream).map_err(|e| e.to_string())?;
    if line.trim().is_empty() {
        return Err("the app closed the connection".into());
    }
    let reply: Reply = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    Ok(reply.answer)
}

/// Called for every prompt; returns the answer or `None` when cancelled. Blocks while the user
/// decides.
pub type Handler = dyn Fn(&str, Kind) -> Option<String> + Send + Sync;

/// Server side, embedded in the app.
pub struct Server {
    port: u16,
    token: String,
}

fn random_token() -> String {
    // Two random UUIDs: 244 bits from the operating system's secure random source.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

impl Server {
    /// Starts listening on a free loopback port. The thread lives as long as the process.
    pub fn start(handler: Arc<Handler>) -> std::io::Result<Server> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let expected = token.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let handler = Arc::clone(&handler);
                let expected = expected.clone();
                std::thread::spawn(move || serve(conn, &expected, &*handler));
            }
        });
        Ok(Server { port, token })
    }

    /// Environment that makes git and ssh use `askpass_program` and this server.
    pub fn env(&self, askpass_program: &str) -> Vec<(String, String)> {
        vec![
            ("GIT_ASKPASS".into(), askpass_program.into()),
            ("SSH_ASKPASS".into(), askpass_program.into()),
            // ssh only consults SSH_ASKPASS without a terminal when told to (OpenSSH 8.4+).
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (ENV_PORT.into(), self.port.to_string()),
            (ENV_TOKEN.into(), self.token.clone()),
        ]
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

fn serve(mut conn: TcpStream, expected_token: &str, handler: &Handler) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(line) = read_line(&mut conn) else {
        return;
    };
    let Ok(wire) = serde_json::from_str::<Wire>(line.trim()) else {
        return;
    };
    if !same(&wire.token, expected_token) {
        return; // not one of ours: drop the connection without a word
    }
    let answer = handler(&clean_prompt(&wire.prompt), wire.kind);
    if let Ok(mut reply) = serde_json::to_string(&Reply { answer }) {
        reply.push('\n');
        let _ = conn.write_all(reply.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn server(answer: impl Fn(&str, Kind) -> Option<String> + Send + Sync + 'static) -> Server {
        Server::start(Arc::new(answer)).unwrap()
    }

    fn token_of(s: &Server) -> String {
        s.env("x")
            .into_iter()
            .find(|(k, _)| k == ENV_TOKEN)
            .unwrap()
            .1
    }

    #[test]
    fn an_answer_travels_from_the_app_back_to_the_asker() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let s = server(move |p, k| {
            log.lock().unwrap().push((p.to_string(), k));
            Some("hunter2".into())
        });
        let got = ask(
            s.port(),
            &token_of(&s),
            "Password for 'https://x@github.com': ",
            Kind::Secret,
        )
        .unwrap();
        assert_eq!(got.as_deref(), Some("hunter2"));
        assert_eq!(
            seen.lock().unwrap()[0],
            (
                "Password for 'https://x@github.com': ".to_string(),
                Kind::Secret
            )
        );
    }

    #[test]
    fn cancelling_is_reported_as_no_answer() {
        let s = server(|_, _| None);
        assert_eq!(
            ask(s.port(), &token_of(&s), "Username: ", Kind::Text).unwrap(),
            None
        );
    }

    #[test]
    fn a_wrong_token_gets_nothing_and_never_reaches_the_handler() {
        let called = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&called);
        let s = server(move |_, _| {
            *flag.lock().unwrap() = true;
            Some("secret".into())
        });
        let r = ask(s.port(), "not-the-token", "Password: ", Kind::Secret);
        assert!(r.is_err(), "the connection is dropped: {r:?}");
        assert!(!*called.lock().unwrap());
    }

    #[test]
    fn prompts_are_cleaned_and_capped_before_display() {
        assert_eq!(clean_prompt("Pass\u{1b}[2Jword\r\n"), "Pass[2Jword\n");
        assert_eq!(clean_prompt(&"a".repeat(5000)).len(), 1000);
        let seen = Arc::new(Mutex::new(String::new()));
        let log = Arc::clone(&seen);
        let s = server(move |p, _| {
            *log.lock().unwrap() = p.to_string();
            Some(String::new())
        });
        ask(s.port(), &token_of(&s), "ok\u{7}\u{0}text", Kind::Text).unwrap();
        assert_eq!(*seen.lock().unwrap(), "oktext");
    }

    #[test]
    fn prompts_are_classified_by_their_wording() {
        assert_eq!(classify("Username for 'https://github.com': "), Kind::Text);
        assert_eq!(
            classify("Password for 'https://me@github.com': "),
            Kind::Secret
        );
        assert_eq!(
            classify("Enter passphrase for key '/home/me/.ssh/id_ed25519': "),
            Kind::Secret
        );
        assert_eq!(
            classify(
                "The authenticity of host 'h (1.2.3.4)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
            ),
            Kind::Confirm
        );
    }

    #[test]
    fn the_environment_names_the_program_and_forces_ssh_to_use_it() {
        let s = server(|_, _| None);
        let env: std::collections::HashMap<_, _> =
            s.env("/path/perseus-askpass").into_iter().collect();
        assert_eq!(env["GIT_ASKPASS"], "/path/perseus-askpass");
        assert_eq!(env["SSH_ASKPASS"], "/path/perseus-askpass");
        assert_eq!(env["SSH_ASKPASS_REQUIRE"], "force");
        assert_eq!(env[ENV_PORT], s.port().to_string());
        assert_eq!(env[ENV_TOKEN].len(), 64);
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
