//! `perseus-credential-helper get|store|erase`
//!
//! Invoked by git (never by hand). The active Perseus profile arrives in the
//! `PERSEUS_PROFILE` environment variable, set by the app for the git commands it runs.
//! OAuth tokens that are about to expire are renewed here, so a long-lived session
//! keeps working without the user signing in again.

use std::io::{self, BufReader};
use std::process::ExitCode;

use perseus_credentials::KeyringStore;
use perseus_credentials::http::UreqHttp;
use perseus_credentials::oauth::now_unix;
use perseus_credentials::protocol::{Op, run};
use perseus_credentials::refresh::{Refresher, default_lock_dir};

fn main() -> ExitCode {
    let Some(op) = std::env::args().nth(1).as_deref().and_then(Op::parse) else {
        eprintln!("usage: perseus-credential-helper get|store|erase");
        return ExitCode::from(2);
    };
    let profile = std::env::var("PERSEUS_PROFILE").ok();

    let http = UreqHttp::new();
    let refresher = Refresher {
        http: &http,
        lock_dir: default_lock_dir(),
        now: now_unix(),
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    match run(
        op,
        BufReader::new(stdin.lock()),
        stdout.lock(),
        profile.as_deref(),
        &KeyringStore,
        Some(&refresher),
    ) {
        Ok(warning) => {
            if let Some(w) = warning {
                // Shown in git's output; never contains a token.
                eprintln!("perseus-credential-helper: {w}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            // The message never contains request values or secrets.
            eprintln!("perseus-credential-helper: {e}");
            ExitCode::FAILURE
        }
    }
}
