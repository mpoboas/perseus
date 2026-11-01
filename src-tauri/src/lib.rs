mod error;
pub mod git;
mod ipc;

use serde::Serialize;
use tauri::Manager;

use ipc::channels::{self, AppState};
use ipc::{commands, protocol};

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
