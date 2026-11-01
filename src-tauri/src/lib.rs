mod error;
mod git;
mod ipc;

use serde::Serialize;

use ipc::channels::{self, AppState};

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            channels::pick_and_open_repo,
            channels::close_repo,
            channels::stream_commits,
            channels::cancel_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
