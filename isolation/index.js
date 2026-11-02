// Tauri Isolation pattern: this script runs in a sandboxed iframe that sits between the
// app's webview and the Rust core. Every IPC message passes through the hook below, and
// Tauri then encrypts it with a key generated at startup, so a compromised page script
// cannot talk to the backend except through this gate.
//
// Keep ALLOWED in sync with src-tauri/build.rs: a test fails when they differ.
const ALLOWED = new Set([
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
  "watch_repo",
  "unwatch_repo",
]);

// Tauri's own plumbing, not an app command. When a Channel message is larger than 8 KiB (every
// chunk of commit history) Tauri stores it and the page fetches it with this command; blocking
// it silently drops the data. It only returns payloads the backend queued for this webview.
const FRAMEWORK = new Set(["plugin:__TAURI_CHANNEL__|fetch"]);

window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  if (typeof payload.cmd !== "string" || !(ALLOWED.has(payload.cmd) || FRAMEWORK.has(payload.cmd))) {
    // The message is dropped, so nothing reaches Rust. The caller's promise simply never
    // settles; this log line is how a developer finds out why. Arguments are not logged.
    console.error("Perseus blocked an IPC call to a command that is not on the allowlist:", String(payload.cmd));
    throw new Error("Perseus blocked an IPC call to an unknown command");
  }
  return payload;
};
