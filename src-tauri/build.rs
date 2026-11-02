use tauri_build::{AppManifest, Attributes};

// Every app command must be listed here so the capability files can grant it
// explicitly (generates an `allow-<command>` permission per entry).
const COMMANDS: &[&str] = &[
    "app_info",
    "pick_and_open_repo",
    "close_repo",
    "stream_commits",
    "cancel_stream",
    "list_refs",
    "commit_detail",
    "commit_files",
    "repo_status",
    "stage_paths",
    "unstage_paths",
    "create_commit",
    "switch_ref",
    "new_branch",
    "run_git_op",
    "cancel_git_op",
    "git_action",
    "list_stashes",
    "list_remotes",
    "file_history",
    "file_blame",
    "commit_template",
    "search_commits",
    "init_repo",
    "clone_repo",
    "open_in",
    "list_conflicts",
    "conflict_detail",
    "resolve_conflict",
    "rebase_plan",
    "interactive_rebase",
    "predict_merge",
    "predict_pick",
    "hosting_info",
    "list_pull_requests",
    "create_pull_request",
    "merge_pull_request",
    "list_issues",
    "ci_state",
    "checkout_pull_request",
    "open_in_browser",
    "watch_askpass",
    "answer_askpass",
    "list_submodules",
    "update_submodules",
    "add_submodule",
    "flow_status",
    "flow_init",
    "flow_start",
    "flow_finish",
    "open_nested_repo",
    "list_worktrees",
    "add_worktree",
    "remove_worktree",
    "lfs_status",
    "lfs_track",
    "large_staged_files",
    "activity_log",
    "undo_snapshot",
    "author_avatar",
    "remote_avatar",
    "undo_restore",
    "commit_signature",
    "generate_ssh_key",
    "export_patch",
    "apply_patch_file",
    "list_profiles",
    "save_profile",
    "delete_profile",
    "set_active_profile",
    "set_credential",
    "remove_credential",
    "pick_ssh_key",
    "oauth_presets",
    "oauth_sign_in",
    "oauth_cancel",
    "list_recent_repos",
    "open_recent_repo",
    "remove_recent_repo",
    "set_repo_favorite",
    "set_repo_alias",
    "repo_stats",
    "fork_repository",
    "watch_links",
    "register_links",
    "links_registered",
    "watch_repo",
    "unwatch_repo",
];

/// Variables taken from `.env` at the repository root and compiled into the app.
const DOTENV_KEYS: &[&str] = &["PERSEUS_GITHUB_CLIENT_ID", "PERSEUS_GITLAB_CLIENT_ID"];

/// Makes the OAuth client IDs in `../.env` visible to `option_env!` in the app. A variable that is
/// already set in the real environment wins, and a missing file or blank value changes nothing.
fn load_dotenv() {
    println!("cargo:rerun-if-changed=../.env");
    for key in DOTENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let Ok(text) = std::fs::read_to_string("../.env") else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().trim_matches(['"', '\'']));
        if DOTENV_KEYS.contains(&key) && !value.is_empty() && std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    load_dotenv();
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
