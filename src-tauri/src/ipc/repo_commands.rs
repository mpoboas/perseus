//! Creating repositories (clone, init) and opening a repository in other tools. Every folder
//! the user picks comes from a native dialog opened here, never from the webview.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::git::cli::GitOverrides;
use crate::git::clone;
use crate::git::repo::{RepoId, RepoInfo};
use crate::ipc::channels::AppState;
use crate::ipc::commands::blocking;
use crate::profiles::{ProfileStore, helper_path};
use crate::recents::RecentStore;

async fn pick_folder(app: AppHandle) -> Result<Option<std::path::PathBuf>> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    picked
        .map(|p| p.into_path().map_err(|e| AppError::Internal(e.to_string())))
        .transpose()
}

/// Asks for a folder, runs `git init` there and opens it.
#[tauri::command]
pub async fn init_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    recents: State<'_, RecentStore>,
    default_branch: Option<String>,
) -> Result<Option<RepoInfo>> {
    let Some(dir) = pick_folder(app).await? else {
        return Ok(None);
    };
    let to_init = dir.clone();
    blocking(move || clone::init_in(&to_init, default_branch.as_deref())).await?;
    let info = state.repos.open(&dir)?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    Ok(Some(info))
}

/// Asks where to put the clone, clones `url` there using the active profile's credentials,
/// streams git's progress, and opens the result. `cancel_git_op(op_id)` stops it.
#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    recents: State<'_, RecentStore>,
    url: String,
    op_id: u32,
    on_progress: Channel<String>,
) -> Result<Option<RepoInfo>> {
    let Some(parent) = pick_folder(app).await? else {
        return Ok(None);
    };
    let overrides = match profiles.active() {
        Some(profile) => profile.git_overrides(helper_path().as_deref())?,
        None => GitOverrides::default(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .ops
        .lock()
        .map_err(|_| AppError::Internal("operation registry poisoned".into()))?
        .insert(op_id, Arc::clone(&cancel));
    let flag = Arc::clone(&cancel);
    let result = blocking(move || {
        clone::clone_into(&parent, &url, overrides, &flag, |line| {
            let _ = on_progress.send(line.to_string());
        })
    })
    .await;
    if let Ok(mut ops) = state.ops.lock()
        && ops.get(&op_id).is_some_and(|f| Arc::ptr_eq(f, &cancel))
    {
        ops.remove(&op_id);
    }
    let target = result?;
    let info = state.repos.open(&target)?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    Ok(Some(info))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenIn {
    /// The system file manager.
    Folder,
    Terminal,
    /// Visual Studio Code, when its `code` command is installed.
    Editor,
}

/// Opens the repository's folder in a file manager, terminal or editor. The path comes from the
/// registry and is passed as a single argument, never through a shell.
#[tauri::command]
pub fn open_in(state: State<'_, AppState>, repo_id: RepoId, target: OpenIn) -> Result<()> {
    let root = state.repos.git(repo_id)?.root().to_path_buf();
    let spawn = |program: &str, args: &[&str]| -> Result<()> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).current_dir(&root);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| AppError::Git(format!("could not start {program}: {e}")))
    };
    match target {
        OpenIn::Folder => {
            open::that(&root).map_err(|e| AppError::Git(format!("could not open the folder: {e}")))
        }
        OpenIn::Editor => spawn("code", &[root.to_string_lossy().as_ref()]),
        OpenIn::Terminal => {
            #[cfg(windows)]
            {
                // Windows Terminal when present, else a plain console window in that folder.
                if spawn("wt.exe", &["-d", root.to_string_lossy().as_ref()]).is_ok() {
                    return Ok(());
                }
                spawn("cmd.exe", &["/c", "start", "cmd.exe"])
            }
            #[cfg(target_os = "macos")]
            {
                spawn("open", &["-a", "Terminal", root.to_string_lossy().as_ref()])
            }
            #[cfg(all(not(windows), not(target_os = "macos")))]
            {
                spawn("x-terminal-emulator", &[]).or_else(|_| spawn("gnome-terminal", &[]))
            }
        }
    }
}
