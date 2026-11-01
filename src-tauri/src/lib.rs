mod error;
pub mod git;
mod ipc;
mod profiles;

use std::sync::Arc;

use perseus_credentials::KeyringStore;
use serde::Serialize;
use tauri::Manager;

use ipc::channels::{self, AppState};
use ipc::{commands, profile_commands, protocol};
use profiles::ProfileStore;

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
        .setup(|app| {
            // Profile metadata lives in the app data dir; tokens stay in the OS keychain.
            let path = app.path().app_data_dir()?.join("profiles.json");
            app.manage(ProfileStore::load(path, Arc::new(KeyringStore)));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // Patches come from a git subprocess: keep that off the protocol thread.
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                responder.respond(protocol::handle(&state.repos, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            channels::pick_and_open_repo,
            channels::close_repo,
            channels::stream_commits,
            channels::cancel_stream,
            commands::list_refs,
            commands::commit_detail,
            commands::commit_files,
            commands::repo_status,
            commands::stage_paths,
            commands::unstage_paths,
            commands::create_commit,
            commands::switch_ref,
            commands::new_branch,
            commands::run_git_op,
            profile_commands::list_profiles,
            profile_commands::save_profile,
            profile_commands::delete_profile,
            profile_commands::set_active_profile,
            profile_commands::set_credential,
            profile_commands::remove_credential,
            profile_commands::pick_ssh_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
