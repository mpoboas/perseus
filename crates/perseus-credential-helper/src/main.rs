//! `perseus-credential-helper get|store|erase`
//!
//! Invoked by git (never by hand). The active Perseus profile arrives in the
//! `PERSEUS_PROFILE` environment variable, set by the app for the git commands it runs.

use std::io::{self, BufReader};
use std::process::ExitCode;

use perseus_credentials::KeyringStore;
use perseus_credentials::protocol::{Op, run};

fn main() -> ExitCode {
    let Some(op) = std::env::args().nth(1).as_deref().and_then(Op::parse) else {
        eprintln!("usage: perseus-credential-helper get|store|erase");
        return ExitCode::from(2);
    };
    let profile = std::env::var("PERSEUS_PROFILE").ok();

    let stdin = io::stdin();
    let stdout = io::stdout();
    match run(
        op,
        BufReader::new(stdin.lock()),
        stdout.lock(),
        profile.as_deref(),
        &KeyringStore,
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // The message never contains request values or secrets.
            eprintln!("perseus-credential-helper: {e}");
            ExitCode::FAILURE
        }
    }
}
