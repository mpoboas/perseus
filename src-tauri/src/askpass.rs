//! Connects git's and ssh's questions (password, passphrase, trust this host?) to the app window.
//!
//! The `perseus-askpass` program sends each question to the embedded server (see the
//! `perseus-askpass` crate). The server calls [`Broker::ask`], which hands the question to the
//! webview over a channel and waits for the user's answer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use perseus_askpass::Kind;
use serde::Serialize;

/// How long a question may wait for the user before git is told "no answer".
const WAIT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Question {
    pub id: u32,
    pub prompt: String,
    pub kind: Kind,
}

type Sink = Box<dyn Fn(Question) + Send + Sync>;

#[derive(Default)]
pub struct Broker {
    next: AtomicU32,
    pending: Mutex<HashMap<u32, mpsc::Sender<Option<String>>>>,
    sink: Mutex<Option<Sink>>,
}

impl Broker {
    /// Where questions are delivered (the webview). Replaces an earlier sink, e.g. after a reload.
    pub fn set_sink(&self, sink: impl Fn(Question) + Send + Sync + 'static) {
        if let Ok(mut s) = self.sink.lock() {
            *s = Some(Box::new(sink));
        }
    }

    /// Asks the user and blocks for the answer. `None` means cancelled, unavailable or timed out.
    pub fn ask(&self, prompt: &str, kind: Kind) -> Option<String> {
        if kind == Kind::Info {
            return Some(String::new());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().ok()?.insert(id, tx);
        {
            let sink = self.sink.lock().ok()?;
            let Some(deliver) = sink.as_ref() else {
                // Nobody is listening (no window): fail the prompt instead of hanging git.
                self.pending.lock().ok()?.remove(&id);
                return None;
            };
            deliver(Question {
                id,
                prompt: prompt.to_string(),
                kind,
            });
        }
        let answer = rx.recv_timeout(WAIT).ok().flatten();
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
        answer
    }

    /// The user's reply (`None` = cancelled). Returns false for an unknown or already-answered id.
    pub fn answer(&self, id: u32, answer: Option<String>) -> bool {
        let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
        tx.is_some_and(|tx| tx.send(answer).is_ok())
    }
}

/// The helper program shipped next to the app, if present.
pub fn program_path() -> Option<std::path::PathBuf> {
    let name = format!("perseus-askpass{}", std::env::consts::EXE_SUFFIX);
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_question_reaches_the_sink_and_the_answer_comes_back() {
        let broker = Arc::new(Broker::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (b, log) = (Arc::clone(&broker), Arc::clone(&seen));
        broker.set_sink(move |q| {
            log.lock().unwrap().push(q.clone());
            // The "UI" answers from another thread, as the webview would.
            let b = Arc::clone(&b);
            std::thread::spawn(move || {
                assert!(b.answer(q.id, Some("pw".into())));
            });
        });
        assert_eq!(
            broker.ask("Password: ", Kind::Secret).as_deref(),
            Some("pw")
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            (seen[0].prompt.as_str(), seen[0].kind),
            ("Password: ", Kind::Secret)
        );
    }

    #[test]
    fn cancelling_and_having_no_window_both_give_no_answer() {
        let broker = Arc::new(Broker::default());
        assert_eq!(
            broker.ask("Password: ", Kind::Secret),
            None,
            "no sink: fail fast, never hang git"
        );

        let b = Arc::clone(&broker);
        broker.set_sink(move |q| {
            let b = Arc::clone(&b);
            std::thread::spawn(move || {
                b.answer(q.id, None);
            });
        });
        assert_eq!(broker.ask("Username: ", Kind::Text), None);
    }

    #[test]
    fn answers_are_matched_by_id_and_only_count_once() {
        let broker = Broker::default();
        assert!(!broker.answer(99, Some("x".into())), "unknown id");
        let (tx, rx) = mpsc::channel();
        broker.pending.lock().unwrap().insert(7, tx);
        assert!(broker.answer(7, Some("first".into())));
        assert!(!broker.answer(7, Some("second".into())), "already answered");
        assert_eq!(rx.recv().unwrap().as_deref(), Some("first"));
    }

    #[test]
    fn informational_prompts_need_no_answer() {
        let broker = Broker::default();
        assert_eq!(
            broker.ask("Touch your key", Kind::Info).as_deref(),
            Some("")
        );
    }
}
