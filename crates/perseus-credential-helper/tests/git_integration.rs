//! End to end: real `git` -> real helper binary -> real OS keychain.
//!
//! Ignored by default because it writes a (temporary) entry to the user's
//! keychain, which CI runners without a keychain service cannot do. Run with:
//! `cargo test -p perseus-credential-helper -- --ignored`

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use perseus_credentials::{Credential, KeyringStore, SecretStore};

const HELPER: &str = env!("CARGO_BIN_EXE_perseus-credential-helper");

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |a, (i, &b)| a | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A server that demands Basic auth and records every `Authorization` header it sees.
struct AuthServer {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl AuthServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let (seen2, stop2) = (seen.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                let Ok((mut conn, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                conn.set_nonblocking(false).unwrap();
                conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match conn.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                let auth = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Authorization: ").map(str::to_string));
                let reply = match auth {
                    Some(a) => {
                        seen2.lock().unwrap().push(a);
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    }
                    None => {
                        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"perseus-test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    }
                };
                let _ = conn.write_all(reply.as_bytes());
            }
        });
        Self {
            port,
            seen,
            stop,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> Vec<String> {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
        self.seen.lock().unwrap().clone()
    }
}

/// Runs `git ls-remote` against the server the way Perseus does: helpers reset,
/// ours installed, profile passed through the environment, prompts disabled.
fn ls_remote(port: u16, profile: &str) -> std::process::Output {
    let helper = HELPER.replace('\\', "/");
    Command::new("git")
        .args([
            "-c",
            "credential.helper=",
            "-c",
            &format!("credential.helper=!\"{helper}\""),
            "ls-remote",
            &format!("http://127.0.0.1:{port}/repo.git"),
        ])
        .env("PERSEUS_PROFILE", profile)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("git runs")
}

struct Cleanup(String, String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = KeyringStore.delete(&self.0, &self.1);
    }
}

#[test]
#[ignore]
fn git_sends_the_profiles_token_and_only_that_profiles() {
    let pid = std::process::id() as u128;
    let owner = format!("{:032x}", pid * 104_729);
    let stranger = format!("{:032x}", pid * 1_299_709);

    let server = AuthServer::start();
    let host = format!("127.0.0.1:{}", server.port);
    let _cleanup = Cleanup(owner.clone(), host.clone());
    KeyringStore
        .set(
            &owner,
            &host,
            &Credential {
                username: "ada".into(),
                token: "tok-12345".into(),
            },
        )
        .unwrap();

    // The owning profile authenticates: git retries with the keychain credential.
    ls_remote(server.port, &owner);
    // Another profile has nothing stored, so git must not send any credential at all.
    let denied = ls_remote(server.port, &stranger);
    assert!(!denied.status.success());

    let seen = server.finish();
    let expected = format!("Basic {}", base64(b"ada:tok-12345"));
    assert_eq!(
        seen,
        vec![expected],
        "only the owner's request carries a token"
    );
}

#[test]
#[ignore]
fn helper_is_silent_for_hosts_without_credentials() {
    let profile = format!("{:032x}", std::process::id() as u128 * 15_485_863);
    let mut child = Command::new(HELPER)
        .arg("get")
        .env("PERSEUS_PROFILE", &profile)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"protocol=https\nhost=no-such-host.invalid\n\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn helper_rejects_injection_attempts_and_bad_usage() {
    // These do not touch the keychain: validation fails before any lookup.
    let run = |args: &[&str], input: &[u8]| {
        let mut child = Command::new(HELPER)
            .args(args)
            .env("PERSEUS_PROFILE", "0123456789abcdef0123456789abcdef")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    };

    let out = run(&["get"], b"protocol=https\nhost=github.com\r\n\n");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());

    let out = run(&["frobnicate"], b"");
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());

    let out = run(&[], b"");
    assert_eq!(out.status.code(), Some(2));

    // store/erase succeed without output and without touching the keychain.
    let out = run(
        &["store"],
        b"protocol=https\nhost=github.com\nusername=x\npassword=y\n\n",
    );
    assert!(out.status.success() && out.stdout.is_empty());
}
