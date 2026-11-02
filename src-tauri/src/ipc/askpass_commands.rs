use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::askpass::{Broker, Question};
use crate::error::Result;

/// Longest answer accepted from the webview.
const MAX_ANSWER: usize = 4096;

/// The webview calls this once at start-up; every question from git or ssh arrives on the channel.
#[tauri::command]
pub fn watch_askpass(broker: State<'_, Arc<Broker>>, on_question: Channel<Question>) {
    broker.set_sink(move |q| {
        let _ = on_question.send(q);
    });
}

/// The user's answer to a question; `None` means they cancelled it. The answer goes straight to the
/// waiting git or ssh process and is not stored.
#[tauri::command]
pub fn answer_askpass(
    broker: State<'_, Arc<Broker>>,
    id: u32,
    answer: Option<String>,
) -> Result<()> {
    let answer = answer.map(|a| a.chars().take(MAX_ANSWER).collect());
    broker.answer(id, answer);
    Ok(())
}
