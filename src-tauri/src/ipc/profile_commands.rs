use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::ipc::commands::blocking;
use crate::profiles::{Profile, ProfileInput, ProfileStore, ProfilesSnapshot};

// The webview never receives a token: it sends one when the user adds it, and only
// non-secret metadata (host, username) comes back. Commands that touch the keychain
// run on a blocking thread because the OS may stop to ask the user to unlock it.

#[tauri::command]
pub fn list_profiles(profiles: State<'_, ProfileStore>) -> Result<ProfilesSnapshot> {
    profiles.snapshot()
}

#[tauri::command]
pub fn save_profile(profiles: State<'_, ProfileStore>, input: ProfileInput) -> Result<Profile> {
    profiles.save(input)
}

#[tauri::command]
pub async fn delete_profile(profiles: State<'_, ProfileStore>, id: String) -> Result<()> {
    let store = profiles.inner().clone();
    blocking(move || store.delete(&id)).await
}

#[tauri::command]
pub fn set_active_profile(profiles: State<'_, ProfileStore>, id: Option<String>) -> Result<()> {
    profiles.set_active(id.as_deref())
}

#[tauri::command]
pub async fn set_credential(
    profiles: State<'_, ProfileStore>,
    id: String,
    host: String,
    username: String,
    token: String,
) -> Result<()> {
    let store = profiles.inner().clone();
    blocking(move || store.set_credential(&id, &host, &username, &token)).await
}

#[tauri::command]
pub async fn remove_credential(
    profiles: State<'_, ProfileStore>,
    id: String,
    host: String,
) -> Result<()> {
    let store = profiles.inner().clone();
    blocking(move || store.remove_credential(&id, &host)).await
}

/// Native file picker for an SSH private key, opened in `~/.ssh` when it exists.
#[tauri::command]
pub async fn pick_ssh_key(app: AppHandle) -> Result<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(ssh) = std::env::home_dir().map(|h| h.join(".ssh"))
            && ssh.is_dir()
        {
            dialog = dialog.set_directory(ssh);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    picked
        .map(|p| {
            p.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| AppError::Internal(e.to_string()))
        })
        .transpose()
}
