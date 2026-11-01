use tauri_build::{AppManifest, Attributes};

// Every app command must be listed here so the capability files can grant it
// explicitly (generates an `allow-<command>` permission per entry).
const COMMANDS: &[&str] = &[
    "app_info",
    "pick_and_open_repo",
    "close_repo",
    "stream_commits",
    "cancel_stream",
];

fn main() {
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
