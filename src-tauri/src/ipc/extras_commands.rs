//! Submodules, worktrees, Git LFS, large-file warnings and the activity log.

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::git::cli::{self, LogEntry};
use crate::git::extras::{self, LargeFile, LfsAction, LfsStatus, Submodule, Worktree};
use crate::git::repo::{RepoId, RepoInfo};
use crate::git::undo;
use crate::git::validate;
use crate::ipc::channels::AppState;
use crate::ipc::commands::{blocking, git_for};
use crate::profiles::ProfileStore;
use crate::recents::RecentStore;

#[tauri::command]
pub async fn list_submodules(
    state: State<'_, AppState>,
    repo_id: RepoId,
) -> Result<Vec<Submodule>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::list_submodules(&git)).await
}

/// Downloads and checks out submodules (all, or one `path`), using the active profile's login.
#[tauri::command]
pub async fn update_submodules(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    path: Option<String>,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || extras::update_submodules(&git, path.as_deref())).await
}

/// Opens a folder inside the repository (a submodule or a linked worktree of it) as its own
/// repository. Only paths the repository itself reports are accepted.
#[tauri::command]
pub async fn open_nested_repo(
    state: State<'_, AppState>,
    recents: State<'_, RecentStore>,
    repo_id: RepoId,
    path: String,
) -> Result<RepoInfo> {
    let git = state.repos.git(repo_id)?;
    let root = git.root().to_path_buf();
    let target = blocking(move || {
        let submodule_dirs = extras::list_submodules(&git)?
            .into_iter()
            .map(|s| root.join(s.path));
        let worktree_dirs = extras::list_worktrees(&git)?
            .into_iter()
            .map(|w| std::path::PathBuf::from(w.path));
        let wanted = std::path::Path::new(&path);
        submodule_dirs
            .chain(worktree_dirs)
            .find(|candidate| {
                candidate == wanted || candidate.ends_with(wanted) && wanted.is_relative()
            })
            .filter(|p| p.join(".git").exists())
            .ok_or_else(|| {
                AppError::Git(
                    "that folder is not a submodule or worktree of this repository".into(),
                )
            })
    })
    .await?;
    let info = state.repos.open(&target)?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    Ok(info)
}

#[tauri::command]
pub async fn list_worktrees(state: State<'_, AppState>, repo_id: RepoId) -> Result<Vec<Worktree>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::list_worktrees(&git)).await
}

/// Asks for a parent folder, then creates `<folder>/<name>` as a linked worktree of `branch`.
#[tauri::command]
pub async fn add_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepoId,
    branch: String,
    create: bool,
) -> Result<Option<String>> {
    let git = state.repos.git(repo_id)?;
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(parent) = picked else {
        return Ok(None);
    };
    let parent = parent
        .into_path()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let name: String = validate::ref_name(&branch)?
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let dir = parent.join(name);
    let shown = dir.to_string_lossy().into_owned();
    blocking(move || extras::add_worktree(&git, &dir, &branch, create)).await?;
    Ok(Some(shown))
}

#[tauri::command]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    repo_id: RepoId,
    path: String,
) -> Result<()> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::remove_worktree(&git, &path)).await
}

#[tauri::command]
pub async fn lfs_status(state: State<'_, AppState>, repo_id: RepoId) -> Result<LfsStatus> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::lfs_status(&git)).await
}

#[tauri::command]
pub async fn lfs_track(state: State<'_, AppState>, repo_id: RepoId, pattern: String) -> Result<()> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::lfs_action(&git, &LfsAction::Track { pattern })).await
}

/// Staged files bigger than `megabytes`, which a commit would add to the history for good.
#[tauri::command]
pub async fn large_staged_files(
    state: State<'_, AppState>,
    repo_id: RepoId,
    megabytes: u64,
) -> Result<Vec<LargeFile>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || extras::large_staged_files(&git, megabytes.clamp(1, 4096) * 1024 * 1024)).await
}

/// The git commands Perseus has run recently (credentials in URLs removed).
#[tauri::command]
pub fn activity_log() -> Vec<LogEntry> {
    cli::recent_commands()
}

/// Where every local branch and tag points, which one is checked out and what is stashed, for undo
/// and redo. `files` also records the staged and on-disk state of the tracked files, which costs a
/// scan of the working tree, so only actions that edit files ask for it.
#[tauri::command]
pub async fn undo_snapshot(
    state: State<'_, AppState>,
    repo_id: RepoId,
    files: Option<bool>,
) -> Result<undo::Snapshot> {
    let git = state.repos.git(repo_id)?;
    blocking(move || {
        if files.unwrap_or(false) {
            undo::snapshot_with_files(&git)
        } else {
            undo::snapshot(&git)
        }
    })
    .await
}

/// Puts the repository back as `snapshot` describes; `from` is the state being left, which lets
/// edits to files be undone only while the files are still as that action left them (see `git::undo`).
#[tauri::command]
pub async fn undo_restore(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    snapshot: undo::Snapshot,
    keep_changes: bool,
    from: Option<undo::Snapshot>,
) -> Result<()> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || undo::restore_from(&git, &snapshot, keep_changes, from.as_ref())).await
}
