//! End to end with real git: `git credential fill` has no stored credential, so it asks for a
//! user name and a password through GIT_ASKPASS, which is our program talking to a test server.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use perseus_askpass::{Kind, Server};

fn run_fill(server: &Server) -> (String, String) {
    let program = env!("CARGO_BIN_EXE_perseus-askpass");
    let mut cmd = Command::new("git");
    cmd.args(["-c", "credential.helper=", "credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in server.env(program) {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("git is installed");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"protocol=https\nhost=example.test\n\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn git_asks_the_app_for_a_username_and_password() {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&prompts);
    let server = Server::start(Arc::new(move |prompt, kind| {
        log.lock().unwrap().push((prompt.to_string(), kind));
        match kind {
            Kind::Secret => Some("s3cret".into()),
            _ => Some("ada".into()),
        }
    }))
    .unwrap();

    let (stdout, stderr) = run_fill(&server);
    assert!(
        stdout.contains("username=ada"),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.contains("password=s3cret"), "stdout: {stdout}");
    let seen = prompts.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].1, Kind::Text);
    assert!(seen[0].0.contains("Username") && seen[0].0.contains("example.test"));
    assert_eq!(seen[1].1, Kind::Secret);
}

#[test]
fn cancelling_the_prompt_makes_git_give_up_instead_of_hanging() {
    let server = Server::start(Arc::new(|_, _| None)).unwrap();
    let (stdout, _stderr) = run_fill(&server);
    assert!(
        !stdout.contains("password="),
        "no credential should come out: {stdout}"
    );
}
