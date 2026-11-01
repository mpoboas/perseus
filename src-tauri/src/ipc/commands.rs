use tauri::State;

use crate::error::{AppError, Result};
use crate::git::detail::{self, CommitDetail};
use crate::git::refs::{self, RefInfo};
use crate::git::repo::RepoId;
use crate::ipc::channels::AppState;

// Small, bounded payloads go through plain `invoke`; large or unbounded data
// (commit history, later diffs) uses Channels / the custom protocol instead.

#[tauri::command]
pub async fn list_refs(state: State<'_, AppState>, repo_id: RepoId) -> Result<Vec<RefInfo>> {
    let repo = state.repos.get(repo_id)?;
    tauri::async_runtime::spawn_blocking(move || refs::list_refs(&repo.to_thread_local()))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn commit_detail(
    state: State<'_, AppState>,
    repo_id: RepoId,
    oid: String,
) -> Result<CommitDetail> {
    let repo = state.repos.get(repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        detail::commit_detail(&repo.to_thread_local(), &oid)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}
