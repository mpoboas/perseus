use std::time::Duration;

use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::git::repo::RepoId;
use crate::ipc::channels::AppState;
use crate::watcher::{self, ChangeSet};

/// How long the repository must be quiet before a change is reported; one `git commit`
/// touches many files and should produce one event, not dozens.
const QUIET: Duration = Duration::from_millis(300);

/// Starts reporting changes of an open repository over `on_change`. The watch ends with
/// `unwatch_repo`, or when the same `watch_id` is reused.
#[tauri::command]
pub fn watch_repo(
    state: State<'_, AppState>,
    repo_id: RepoId,
    watch_id: u32,
    on_change: Channel<ChangeSet>,
) -> Result<()> {
    let root = state.repos.git(repo_id)?.root().to_path_buf();
    let watch = watcher::watch(&root, QUIET, move |set| {
        let _ = on_change.send(set);
    })?;
    state
        .watches
        .lock()
        .map_err(|_| AppError::Internal("watch registry poisoned".into()))?
        .insert(watch_id, watch);
    Ok(())
}

#[tauri::command]
pub fn unwatch_repo(state: State<'_, AppState>, watch_id: u32) {
    if let Ok(mut watches) = state.watches.lock() {
        watches.remove(&watch_id);
    }
}
