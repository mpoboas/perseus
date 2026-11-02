//! Conflict resolution, interactive rebase and conflict prediction.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::git::conflicts::{self, ConflictDetail, ConflictFile, Resolution};
use crate::git::rebase::{self, PlanCommit, Prediction, TodoItem};
use crate::git::repo::RepoId;
use crate::ipc::channels::AppState;
use crate::ipc::commands::{blocking, git_for};
use crate::profiles::ProfileStore;

#[tauri::command]
pub async fn list_conflicts(
    state: State<'_, AppState>,
    repo_id: RepoId,
) -> Result<Vec<ConflictFile>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || conflicts::list(&git)).await
}

#[tauri::command]
pub async fn conflict_detail(
    state: State<'_, AppState>,
    repo_id: RepoId,
    path: String,
) -> Result<ConflictDetail> {
    let git = state.repos.git(repo_id)?;
    blocking(move || conflicts::detail(&git, &path)).await
}

#[tauri::command]
pub async fn resolve_conflict(
    state: State<'_, AppState>,
    repo_id: RepoId,
    path: String,
    resolution: Resolution,
) -> Result<()> {
    let git = state.repos.git(repo_id)?;
    blocking(move || conflicts::resolve(&git, &path, &resolution)).await
}

#[tauri::command]
pub async fn rebase_plan(
    state: State<'_, AppState>,
    repo_id: RepoId,
    base: String,
) -> Result<Vec<PlanCommit>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || rebase::plan(&git, &base)).await
}

/// Runs an interactive rebase onto `base` following `items`. Stops (resolving with an error) when
/// the todo asks for an edit or hits a conflict; the Changes tab then offers continue and abort.
/// `cancel_git_op` with the same `op_id` stops it.
#[tauri::command]
pub async fn interactive_rebase(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    op_id: u32,
    base: String,
    items: Vec<TodoItem>,
    on_progress: Channel<String>,
) -> Result<String> {
    let git = git_for(&state, &profiles, repo_id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .ops
        .lock()
        .map_err(|_| AppError::Internal("operation registry poisoned".into()))?
        .insert(op_id, Arc::clone(&cancel));
    let flag = Arc::clone(&cancel);
    let result = blocking(move || {
        rebase::start(&git, &base, &items, &flag, |line| {
            let _ = on_progress.send(line.to_string());
        })
    })
    .await;
    if let Ok(mut ops) = state.ops.lock()
        && ops.get(&op_id).is_some_and(|f| Arc::ptr_eq(f, &cancel))
    {
        ops.remove(&op_id);
    }
    result
}

/// Files that would conflict if `theirs` were merged into `ours`. Changes nothing.
#[tauri::command]
pub async fn predict_merge(
    state: State<'_, AppState>,
    repo_id: RepoId,
    ours: String,
    theirs: String,
) -> Result<Prediction> {
    let git = state.repos.git(repo_id)?;
    blocking(move || rebase::predict_merge(&git, &ours, &theirs)).await
}

#[tauri::command]
pub async fn predict_pick(
    state: State<'_, AppState>,
    repo_id: RepoId,
    onto: String,
    oid: String,
) -> Result<Prediction> {
    let git = state.repos.git(repo_id)?;
    blocking(move || rebase::predict_pick(&git, &onto, &oid)).await
}
