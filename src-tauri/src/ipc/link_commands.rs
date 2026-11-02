use tauri::ipc::Channel;
use tauri::{AppHandle, State};
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(any(windows, target_os = "linux"))]
use crate::error::AppError;
use crate::error::Result;
#[cfg(any(windows, target_os = "linux"))]
use crate::links::SCHEME;
use crate::links::{Link, LinkState};

/// The webview calls this once at start-up; every link that opens a repository arrives on the
/// channel (links that came in before then are sent first).
#[tauri::command]
pub fn watch_links(links: State<'_, LinkState>, on_link: Channel<Link>) {
    links.watch(on_link);
}

/// Whether the operating system sends `perseus-app://` links to this copy of Perseus. Installed
/// copies register themselves; a copy that was only unpacked can do it from Settings.
#[tauri::command]
pub fn links_registered(app: AppHandle) -> Result<bool> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        app.deep_link()
            .is_registered(SCHEME)
            .map_err(|e| AppError::Internal(e.to_string()))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = &app;
        Ok(true)
    }
}

/// Registers `perseus-app://` for the current user, pointing at this copy of Perseus.
#[tauri::command]
pub fn register_links(app: AppHandle) -> Result<()> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        app.deep_link()
            .register(SCHEME)
            .map_err(|e| AppError::Internal(e.to_string()))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = &app;
        Ok(())
    }
}
