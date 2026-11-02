mod error;
pub mod git;
mod ipc;
mod profiles;
mod recents;
mod watcher;

use std::sync::Arc;

use perseus_credentials::KeyringStore;
use serde::Serialize;
use tauri::Manager;

use ipc::channels::{self, AppState};
use ipc::oauth_commands::{self, OAuthFlows};
use ipc::{
    commands, patch_commands, profile_commands, protocol, recent_commands, repo_commands,
    watch_commands,
};
use profiles::ProfileStore;
use recents::RecentStore;

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
        .manage(OAuthFlows::default())
        .setup(|app| {
            // Profile metadata lives in the app data dir; tokens stay in the OS keychain.
            // `PERSEUS_DATA_DIR` redirects it (end-to-end tests use a throwaway directory).
            let data_dir = match std::env::var_os("PERSEUS_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            app.manage(ProfileStore::load(
                data_dir.join("profiles.json"),
                Arc::new(KeyringStore),
            ));
            app.manage(RecentStore::load(data_dir.join("recents.json")));
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
            commands::cancel_git_op,
            commands::git_action,
            commands::list_stashes,
            commands::list_remotes,
            commands::file_history,
            commands::file_blame,
            commands::commit_template,
            commands::search_commits,
            repo_commands::init_repo,
            repo_commands::clone_repo,
            repo_commands::open_in,
            patch_commands::export_patch,
            patch_commands::apply_patch_file,
            profile_commands::list_profiles,
            profile_commands::save_profile,
            profile_commands::delete_profile,
            profile_commands::set_active_profile,
            profile_commands::set_credential,
            profile_commands::remove_credential,
            profile_commands::pick_ssh_key,
            oauth_commands::oauth_presets,
            oauth_commands::oauth_sign_in,
            oauth_commands::oauth_cancel,
            recent_commands::list_recent_repos,
            recent_commands::open_recent_repo,
            recent_commands::remove_recent_repo,
            watch_commands::watch_repo,
            watch_commands::unwatch_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
