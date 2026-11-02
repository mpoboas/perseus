use std::path::Path;

use tauri::State;

use crate::error::{AppError, Result};
use crate::git::repo::RepoInfo;
use crate::ipc::channels::AppState;
use crate::recents::{RecentStore, RecentView};

#[tauri::command]
pub fn list_recent_repos(recents: State<'_, RecentStore>) -> Result<Vec<RecentView>> {
    recents.list()
}

/// Opens a repository from the recents list. Only paths already in the list are accepted:
/// the webview cannot use this command to open anything else.
#[tauri::command]
pub fn open_recent_repo(
    state: State<'_, AppState>,
    recents: State<'_, RecentStore>,
    path: String,
) -> Result<RepoInfo> {
    if !recents.contains(&path) {
        return Err(AppError::Git(
            "that repository is not in your recent list".into(),
        ));
    }
    if !Path::new(&path).is_dir() {
        return Err(AppError::Git("that folder no longer exists".into()));
    }
    let info = state.repos.open(Path::new(&path))?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    Ok(info)
}

#[tauri::command]
pub fn remove_recent_repo(recents: State<'_, RecentStore>, path: String) -> Result<()> {
    recents.remove(&path)
}
