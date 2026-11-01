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
]);

window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  if (typeof payload.cmd !== "string" || !ALLOWED.has(payload.cmd)) {
    // Dropping the message makes the caller's promise reject; nothing reaches Rust.
    throw new Error("Perseus blocked an IPC call to an unknown command");
  }
  return payload;
};
