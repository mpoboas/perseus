mod askpass;
mod crashlog;
mod error;
pub mod git;
mod hosting;
mod ipc;
mod links;
mod profiles;
mod recents;
mod watcher;

use std::sync::Arc;

use perseus_credentials::KeyringStore;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

use ipc::account_commands::{self, Folders};
use ipc::askpass_commands;
use ipc::channels::{self, AppState};
use ipc::extras_commands;
mod avatars;
use ipc::hosting_commands::{self, HostingState};
use ipc::link_commands;
use ipc::oauth_commands::{self, OAuthFlows};
use ipc::signing_commands::{self, DataDir};
use ipc::{
    commands, patch_commands, profile_commands, protocol, recent_commands, repo_commands,
    rewrite_commands, watch_commands,
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
    let mut builder = tauri::Builder::default();
    // A second launch (a `perseus-app://` link, or the shortcut again) hands over to the running
    // window instead of opening another. It must be registered first, and is skipped when
    // `PERSEUS_DATA_DIR` redirects the data (end-to-end tests run several copies side by side).
    if std::env::var_os("PERSEUS_DATA_DIR").is_none() {
        // With its `deep-link` feature the plugin passes the second launch's link on to
        // `on_open_url` below, so this only has to bring the window forward.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            links::show_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(OAuthFlows::default())
        .manage(HostingState::default())
        .manage(links::LinkState::default())
        .setup(|app| {
            // Git and ssh ask their questions through this window.
            let broker = Arc::new(askpass::Broker::default());
            if let Some(program) = askpass::program_path() {
                let handler_broker = Arc::clone(&broker);
                match perseus_askpass::Server::start(Arc::new(move |prompt, kind| {
                    handler_broker.ask(prompt, kind)
                })) {
                    Ok(server) => {
                        let mut env = server.env(&program.to_string_lossy());
                        // Git Credential Manager would open its own window; questions should
                        // come through Perseus. It still supplies credentials it has stored.
                        env.push(("GCM_INTERACTIVE".into(), "never".into()));
                        git::cli::set_global_env(env);
                    }
                    Err(e) => eprintln!("perseus: prompts from git will not work: {e}"),
                }
            }
            app.manage(broker);
            // Profile metadata lives in the app data dir; tokens stay in the OS keychain.
            // `PERSEUS_DATA_DIR` redirects it (end-to-end tests use a throwaway directory).
            let data_dir = match std::env::var_os("PERSEUS_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app.path().app_data_dir()?,
            };
            crashlog::install(&data_dir);
            app.manage(DataDir(data_dir.clone()));
            app.manage(ProfileStore::load(
                data_dir.join("profiles.json"),
                Arc::new(KeyringStore),
            ));
            app.manage(RecentStore::load(data_dir.join("recents.json")));
            app.manage(Folders::new(data_dir.join("last-folder.txt")));

            // Links that open a repository: the ones that started this launch, and later ones.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                links::handle(
                    &handle,
                    event.urls().iter().map(ToString::to_string).collect(),
                );
            });
            let launched_with: Vec<String> = std::env::args().skip(1).collect();
            links::handle(app.handle(), launched_with);
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
            rewrite_commands::list_conflicts,
            rewrite_commands::conflict_detail,
            rewrite_commands::resolve_conflict,
            rewrite_commands::rebase_plan,
            rewrite_commands::interactive_rebase,
            rewrite_commands::predict_merge,
            rewrite_commands::predict_pick,
            hosting_commands::hosting_info,
            hosting_commands::list_pull_requests,
            hosting_commands::create_pull_request,
            hosting_commands::merge_pull_request,
            hosting_commands::list_issues,
            hosting_commands::ci_state,
            hosting_commands::checkout_pull_request,
            hosting_commands::open_in_browser,
            askpass_commands::watch_askpass,
            askpass_commands::answer_askpass,
            extras_commands::list_submodules,
            extras_commands::update_submodules,
            extras_commands::add_submodule,
            extras_commands::flow_status,
            extras_commands::flow_init,
            extras_commands::flow_start,
            extras_commands::flow_finish,
            extras_commands::open_nested_repo,
            extras_commands::list_worktrees,
            extras_commands::add_worktree,
            extras_commands::remove_worktree,
            extras_commands::lfs_status,
            extras_commands::lfs_track,
            extras_commands::large_staged_files,
            extras_commands::activity_log,
            extras_commands::undo_snapshot,
            avatars::author_avatar,
            avatars::remote_avatar,
            extras_commands::undo_restore,
            commands::commit_signature,
            signing_commands::generate_ssh_key,
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
            recent_commands::set_repo_favorite,
            recent_commands::set_repo_alias,
            extras_commands::repo_stats,
            hosting_commands::fork_repository,
            account_commands::choose_folder,
            account_commands::host_accounts,
            account_commands::list_remote_repositories,
            account_commands::list_namespaces,
            account_commands::clone_from_host,
            account_commands::create_repository,
            link_commands::watch_links,
            link_commands::register_links,
            link_commands::links_registered,
            watch_commands::watch_repo,
            watch_commands::unwatch_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
