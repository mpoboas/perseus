use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::error::Result;
use crate::git::signing;
use crate::ipc::commands::blocking;

/// Where Perseus keeps the app's own files (the same folder profiles and recents use).
pub struct DataDir(pub PathBuf);

#[derive(Serialize)]
pub struct GeneratedKey {
    /// The private key file, to store in the profile. The private key itself is never sent.
    pub path: String,
    /// The public key, to paste into GitHub, GitLab or an allowed-signers list.
    pub public_key: String,
}

/// Creates an SSH key pair for a profile in the app's data folder.
#[tauri::command]
pub async fn generate_ssh_key(
    data_dir: State<'_, DataDir>,
    label: String,
    comment: String,
) -> Result<GeneratedKey> {
    let dir = data_dir.0.join("ssh");
    blocking(move || {
        let key = signing::generate_key(&dir, &label, &comment)?;
        Ok(GeneratedKey {
            path: key.path.to_string_lossy().into_owned(),
            public_key: key.public_key,
        })
    })
    .await
}
