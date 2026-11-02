use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::git::actions::{self, Action, RemoteInfo, StashEntry};
use crate::git::cli::Git;
use crate::git::detail::{self, CommitDetail};
use crate::git::diff::{self, FileChange};
use crate::git::history::{self, Blame, FileCommit};
use crate::git::ops::{self, GitOp, SwitchTarget};
use crate::git::refs::{self, RefInfo};
use crate::git::repo::RepoId;
use crate::git::search::{self, Hits, SearchQuery};
use crate::git::status::{self, RepoStatus};
use crate::ipc::channels::AppState;
use crate::profiles::{ProfileStore, helper_path};

// Small, bounded payloads go through plain `invoke`; large or unbounded data
// (commit history, diffs) uses Channels / the `perseus://` protocol instead.

/// Runs blocking git/gix work off the async executor.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// A git runner for `repo_id` acting as the active profile (identity, SSH key,
/// credential helper), or plain system behaviour when no profile is active.
fn git_for(state: &AppState, profiles: &ProfileStore, repo_id: RepoId) -> Result<Git> {
    let git = state.repos.git(repo_id)?;
    match profiles.active() {
        Some(profile) => Ok(git.with_overrides(profile.git_overrides(helper_path().as_deref())?)),
        None => Ok(git),
    }
}

#[tauri::command]
pub async fn list_refs(state: State<'_, AppState>, repo_id: RepoId) -> Result<Vec<RefInfo>> {
    let repo = state.repos.get(repo_id)?;
    let git = state.repos.git(repo_id)?;
    blocking(move || {
        let mut list = refs::list_refs(&repo.to_thread_local())?;
        refs::attach_upstreams(&git, &mut list);
        Ok(list)
    })
    .await
}

#[tauri::command]
pub async fn commit_detail(
    state: State<'_, AppState>,
    repo_id: RepoId,
    oid: String,
) -> Result<CommitDetail> {
    let repo = state.repos.get(repo_id)?;
    blocking(move || detail::commit_detail(&repo.to_thread_local(), &oid)).await
}

#[tauri::command]
pub async fn commit_files(
    state: State<'_, AppState>,
    repo_id: RepoId,
    oid: String,
) -> Result<Vec<FileChange>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || diff::commit_files(&git, &oid)).await
}

#[tauri::command]
pub async fn repo_status(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
) -> Result<RepoStatus> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || status::read(&git)).await
}

#[tauri::command]
pub async fn stage_paths(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    paths: Vec<String>,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || ops::stage(&git, &paths)).await
}

#[tauri::command]
pub async fn unstage_paths(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    paths: Vec<String>,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || ops::unstage(&git, &paths)).await
}

#[tauri::command]
pub async fn create_commit(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    message: String,
    amend: bool,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || ops::commit(&git, &message, amend)).await
}

#[tauri::command]
pub async fn switch_ref(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    target: SwitchTarget,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || ops::switch(&git, &target)).await
}

#[tauri::command]
pub async fn new_branch(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || ops::create_branch(&git, &name, start.as_deref(), checkout)).await
}

/// Fetch/pull/push/merge/rebase/cherry-pick/abort/continue. Progress lines from git
/// stream over `on_progress`; the resolved value is git's final stdout. `cancel_git_op` with the
/// same `op_id` stops it.
#[tauri::command]
pub async fn run_git_op(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    op_id: u32,
    op: GitOp,
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
        ops::run_cancellable(&git, &op, &flag, |line| {
            let _ = on_progress.send(line.to_string());
        })
    })
    .await;
    if let Ok(mut ops) = state.ops.lock() {
        // Only remove our own entry: the id may have been reused by a newer operation.
        if ops.get(&op_id).is_some_and(|f| Arc::ptr_eq(f, &cancel)) {
            ops.remove(&op_id);
        }
    }
    result
}

#[tauri::command]
pub fn cancel_git_op(state: State<'_, AppState>, op_id: u32) {
    if let Ok(ops) = state.ops.lock()
        && let Some(flag) = ops.get(&op_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Quick actions: stash, tags, branch management, reset, revert, discard, remotes.
#[tauri::command]
pub async fn git_action(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    action: Action,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || actions::run(&git, &action)).await
}

#[tauri::command]
pub async fn list_stashes(state: State<'_, AppState>, repo_id: RepoId) -> Result<Vec<StashEntry>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || actions::list_stashes(&git)).await
}

#[tauri::command]
pub async fn list_remotes(state: State<'_, AppState>, repo_id: RepoId) -> Result<Vec<RemoteInfo>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || actions::list_remotes(&git)).await
}

#[tauri::command]
pub async fn file_history(
    state: State<'_, AppState>,
    repo_id: RepoId,
    path: String,
) -> Result<Vec<FileCommit>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || history::file_history(&git, &path)).await
}

#[tauri::command]
pub async fn file_blame(
    state: State<'_, AppState>,
    repo_id: RepoId,
    path: String,
    rev: Option<String>,
) -> Result<Blame> {
    let git = state.repos.git(repo_id)?;
    blocking(move || history::blame(&git, &path, rev.as_deref())).await
}

#[tauri::command]
pub async fn commit_template(
    state: State<'_, AppState>,
    repo_id: RepoId,
) -> Result<Option<String>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || history::commit_template(&git)).await
}

#[tauri::command]
pub async fn search_commits(
    state: State<'_, AppState>,
    repo_id: RepoId,
    query: SearchQuery,
) -> Result<Hits> {
    let git = state.repos.git(repo_id)?;
    blocking(move || search::search(&git, &query)).await
}
