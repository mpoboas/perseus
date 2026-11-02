use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::detail::{self, CommitDetail};
use crate::git::diff::{self, FileChange};
use crate::git::ops::{self, GitOp, SwitchTarget};
use crate::git::refs::{self, RefInfo};
use crate::git::repo::RepoId;
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
/// stream over `on_progress`; the resolved value is git's final stdout.
#[tauri::command]
pub async fn run_git_op(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    op: GitOp,
    on_progress: Channel<String>,
) -> Result<String> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || {
        ops::run(&git, &op, |line| {
            let _ = on_progress.send(line.to_string());
        })
    })
    .await
}
