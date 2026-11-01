//! OAuth end to end against a local fake GitLab-style provider, over real HTTP:
//! device flow -> real OS keychain -> an expired token -> real `git` -> the real
//! helper binary refreshes it -> the server sees the refreshed token.
//!
//! Ignored by default because it writes a (temporary) keychain entry. Run with:
//! `cargo test -p perseus-credential-helper -- --ignored`

mod common;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{base64, parse_form};
use perseus_credentials::http::UreqHttp;
use perseus_credentials::oauth::{Kind, Provider, now_unix, run_device_flow};
use perseus_credentials::{KeyringStore, SecretStore};

const HELPER: &str = env!("CARGO_BIN_EXE_perseus-credential-helper");

#[derive(Default)]
struct Provider_ {
    device_polls: AtomicUsize,
    refresh_calls: AtomicUsize,
    git_auth: Mutex<Vec<String>>,
}

fn serve(mut conn: TcpStream, port: u16, state: &Provider_) {
    conn.set_nonblocking(false).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let (mut buf, mut chunk) = (Vec::new(), [0u8; 2048]);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let content_len = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    while buf.len() < head_end + content_len {
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
    let form = parse_form(&body);
    let field = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let request_line = head.lines().next().unwrap_or("").to_string();

    let (status, payload) = if request_line.starts_with("POST /oauth/authorize_device") {
        (
            "200 OK",
            format!(
                r#"{{"device_code":"dc-1","user_code":"ABCD-1234","verification_uri":"http://127.0.0.1:{port}/oauth/device","expires_in":300,"interval":1}}"#
            ),
        )
    } else if request_line.starts_with("POST /oauth/token") {
        match field("grant_type") {
            Some("urn:ietf:params:oauth:grant-type:device_code") => {
                if state.device_polls.fetch_add(1, Ordering::SeqCst) == 0 {
                    (
                        "400 Bad Request",
                        r#"{"error":"authorization_pending"}"#.to_string(),
                    )
                } else {
                    // Expires after one second, i.e. already due for renewal (the helper renews early).
                    (
                        "200 OK",
                        r#"{"access_token":"at-1","refresh_token":"rt-1","expires_in":1,"token_type":"Bearer"}"#.to_string(),
                    )
                }
            }
            Some("refresh_token") if field("refresh_token") == Some("rt-1") => {
                state.refresh_calls.fetch_add(1, Ordering::SeqCst);
                (
                    "200 OK",
                    r#"{"access_token":"at-2","refresh_token":"rt-2","expires_in":7200,"token_type":"Bearer"}"#.to_string(),
                )
            }
            // A spent or unknown refresh token, as a rotating provider would answer.
            _ => (
                "400 Bad Request",
                r#"{"error":"invalid_grant"}"#.to_string(),
            ),
        }
    } else if request_line.contains("/repo.git/") {
        match head.lines().find_map(|l| l.strip_prefix("Authorization: ")) {
            Some(a) => {
                state.git_auth.lock().unwrap().push(a.to_string());
                ("404 Not Found", String::new())
            }
            None => ("401 Unauthorized", String::new()),
        }
    } else {
        ("404 Not Found", String::new())
    };

    let extra = if status.starts_with("401") {
        "WWW-Authenticate: Basic realm=\"perseus-test\"\r\n"
    } else {
        ""
    };
    let reply = format!(
        "HTTP/1.1 {status}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = conn.write_all(reply.as_bytes());
}

struct Cleanup(String, String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = KeyringStore.delete(&self.0, &self.1);
    }
}

#[test]
#[ignore]
fn device_flow_then_expired_token_is_refreshed_by_the_helper_for_git() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Provider_::default());
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let (state, stop) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((conn, _)) => serve(conn, port, &state),
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        })
    };

    // 1. The device flow, over real HTTP, against the fake provider.
    let host = format!("127.0.0.1:{port}");
    let provider = Provider::new(Kind::GitLab, &host, "client-id").unwrap();
    let shown = Mutex::new(None);
    let tokens = run_device_flow(
        &UreqHttp::new(),
        &provider,
        &mut |c| {
            *shown.lock().unwrap() = Some(c.clone());
            Ok(())
        },
        &AtomicBool::new(false),
        &|_| {}, // do not actually wait out the polling interval
    )
    .expect("device flow completes");
    let challenge = shown.lock().unwrap().clone().expect("code was shown");
    assert_eq!(challenge.user_code, "ABCD-1234");
    assert_eq!(
        challenge.verification_uri,
        format!("http://{host}/oauth/device")
    );
    assert_eq!(tokens.access_token, "at-1");
    assert_eq!(tokens.refresh_token.as_deref(), Some("rt-1"));

    // 2. Store it exactly as the app does.
    let profile = format!("{:032x}", std::process::id() as u128 * 32_452_843);
    let _cleanup = Cleanup(profile.clone(), host.clone());
    KeyringStore
        .set(&profile, &host, &provider.credential(&tokens, now_unix()))
        .unwrap();

    // 3. git asks the helper; the token is due, so the helper renews it first.
    let ls_remote = || {
        Command::new("git")
            .args([
                "-c",
                "credential.helper=",
                "-c",
                &format!("credential.helper=!\"{}\"", HELPER.replace('\\', "/")),
                "ls-remote",
                &format!("http://{host}/repo.git"),
            ])
            .env("PERSEUS_PROFILE", &profile)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .expect("git runs")
    };
    ls_remote();
    // 4. A second git call finds a valid token and must not refresh again.
    ls_remote();

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();

    let expect = format!("Basic {}", base64(b"oauth2:at-2"));
    assert_eq!(
        *state.git_auth.lock().unwrap(),
        vec![expect.clone(), expect],
        "git must send the refreshed token, never the expired one"
    );
    assert_eq!(
        state.refresh_calls.load(Ordering::SeqCst),
        1,
        "refreshed once, not per call"
    );

    let stored = KeyringStore.get(&profile, &host).unwrap().unwrap();
    assert_eq!(stored.token, "at-2");
    let oauth = stored.oauth.unwrap();
    assert_eq!(
        oauth.refresh_token.as_deref(),
        Some("rt-2"),
        "rotated refresh token was saved"
    );
    assert!(oauth.expires_at.unwrap() > now_unix() + 3600);
}
