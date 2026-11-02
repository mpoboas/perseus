//! The program git and ssh run to ask a question. Usage: `perseus-askpass "<prompt>"`.
//!
//! The answer goes to standard output, as git and ssh expect. For ssh's yes/no questions
//! (`SSH_ASKPASS_PROMPT=confirm`) the answer is the exit status instead: 0 means yes.

use std::io::Write;
use std::process::ExitCode;

use perseus_askpass::{ENV_PORT, ENV_TOKEN, Kind, ask, classify};

fn main() -> ExitCode {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let (Some(port), Some(token)) = (
        std::env::var(ENV_PORT)
            .ok()
            .and_then(|p| p.parse::<u16>().ok()),
        std::env::var(ENV_TOKEN).ok(),
    ) else {
        eprintln!("perseus-askpass: not started by Perseus, so there is nobody to ask");
        return ExitCode::FAILURE;
    };

    let ssh_mode = std::env::var("SSH_ASKPASS_PROMPT").ok();
    let kind = match ssh_mode.as_deref() {
        Some("confirm") => Kind::Confirm,
        Some("none") => Kind::Info,
        _ => classify(&prompt),
    };

    match ask(port, &token, &prompt, kind) {
        Ok(Some(answer)) => {
            if kind == Kind::Confirm && ssh_mode.as_deref() == Some("confirm") {
                return if answer == "yes" {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                };
            }
            if kind == Kind::Info {
                return ExitCode::SUCCESS;
            }
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("perseus-askpass: {e}");
            ExitCode::FAILURE
        }
    }
}
