//! Exporting and importing patch files. The file dialogs open from here, so the webview never
//! names a path: it cannot read or write anywhere except where the user picks in the native dialog.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::repo::RepoId;
use crate::git::validate;
use crate::ipc::channels::AppState;
use crate::ipc::commands::blocking;

/// Largest patch file Perseus will read (a safety net against picking something huge by mistake).
const MAX_PATCH_FILE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum PatchSource {
    /// One commit as an mbox-style patch (`git format-patch`), keeping its author and message.
    Commit { oid: String },
    /// Uncommitted changes: the staged ones or the unstaged ones.
    Worktree { staged: bool },
}

pub fn render_patch(git: &Git, source: &PatchSource) -> Result<Vec<u8>> {
    match source {
        PatchSource::Commit { oid } => {
            let oid = validate::oid(oid)?.to_string();
            git.output(["format-patch", "-1", "--stdout", "--binary", oid.as_str()])
        }
        PatchSource::Worktree { staged } => {
            let mut args = vec!["diff", "--binary", "--no-color"];
            if *staged {
                args.push("--cached");
            }
            git.output(args)
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Saved {
    /// File name only (never the full path), for a confirmation message.
    pub name: String,
    pub bytes: usize,
}

/// Asks where to save, then writes the patch git generates. `None` when the user cancels.
#[tauri::command]
pub async fn export_patch(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepoId,
    source: PatchSource,
) -> Result<Option<Saved>> {
    let git = state.repos.git(repo_id)?;
    let patch = blocking(move || render_patch(&git, &source)).await?;
    if patch.is_empty() {
        return Err(AppError::Git("there is nothing to export".into()));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Patch", &["patch", "diff"])
            .set_file_name("changes.patch")
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(&path, &patch).map_err(AppError::git)?;
    Ok(Some(Saved {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        bytes: patch.len(),
    }))
}

/// Asks for a patch file and applies it: to the working tree, or (with `to_index`) to the working
/// tree and the index. The patch is checked first, so a patch that does not fit changes nothing.
#[tauri::command]
pub async fn apply_patch_file(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepoId,
    to_index: bool,
) -> Result<Option<String>> {
    let git = state.repos.git(repo_id)?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Patch", &["patch", "diff"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let meta = std::fs::metadata(&path).map_err(AppError::git)?;
    if meta.len() > MAX_PATCH_FILE {
        return Err(AppError::Git("that file is too large to be a patch".into()));
    }
    let bytes = std::fs::read(&path).map_err(AppError::git)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    blocking(move || apply_patch_bytes(&git, &bytes, to_index)).await?;
    Ok(Some(name))
}

/// Applies mbox-style or plain diff patches. `--check` first means all-or-nothing.
pub fn apply_patch_bytes(git: &Git, patch: &[u8], to_index: bool) -> Result<()> {
    let mut base = vec!["apply", "--whitespace=nowarn"];
    if to_index {
        base.push("--index");
    }
    let mut check = base.clone();
    check.insert(1, "--check");
    check.push("-");
    git.output_with_stdin(check, patch)
        .map_err(|e| AppError::Git(format!("the patch does not apply: {e}")))?;
    base.push("-");
    git.output_with_stdin(base, patch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn oid(git: &Git) -> String {
        String::from_utf8_lossy(&git.output(["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string()
    }

    #[test]
    fn a_commit_exports_and_applies_elsewhere() {
        let (_d1, one) = init_repo();
        commit_file(&one, "a.txt", "a\n", "base");
        commit_file(&one, "b.txt", "b\n", "add b");
        let patch = render_patch(&one, &PatchSource::Commit { oid: oid(&one) }).unwrap();
        assert!(String::from_utf8_lossy(&patch).contains("Subject: [PATCH] add b"));

        // A second repo with only the base commit takes the patch.
        let (_d2, two) = init_repo();
        commit_file(&two, "a.txt", "a\n", "base");
        apply_patch_bytes(&two, &patch, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(two.root().join("b.txt")).unwrap(),
            "b\n"
        );
        // Applied to the working tree only: nothing staged.
        assert!(
            two.output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn worktree_patches_cover_staged_and_unstaged_changes() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        write(&git, "a.txt", "a\nstaged\n");
        git.output(["add", "a.txt"]).unwrap();
        write(&git, "a.txt", "a\nstaged\nunstaged\n");
        let staged = String::from_utf8_lossy(
            &render_patch(&git, &PatchSource::Worktree { staged: true }).unwrap(),
        )
        .into_owned();
        let unstaged = String::from_utf8_lossy(
            &render_patch(&git, &PatchSource::Worktree { staged: false }).unwrap(),
        )
        .into_owned();
        assert!(staged.contains("+staged") && !staged.contains("+unstaged"));
        assert!(unstaged.contains("+unstaged") && !unstaged.contains("+staged"));
    }

    #[test]
    fn a_patch_that_does_not_fit_changes_nothing() {
        let (_d1, one) = init_repo();
        commit_file(&one, "a.txt", "one\n", "base");
        write(&one, "a.txt", "ONE\n");
        let patch = render_patch(&one, &PatchSource::Worktree { staged: false }).unwrap();

        let (_d2, two) = init_repo();
        commit_file(&two, "a.txt", "something else entirely\n", "base");
        let err = apply_patch_bytes(&two, &patch, false).unwrap_err();
        assert!(err.to_string().contains("does not apply"), "{err}");
        assert_eq!(
            std::fs::read_to_string(two.root().join("a.txt")).unwrap(),
            "something else entirely\n"
        );
    }

    #[test]
    fn hostile_sources_are_rejected() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        assert!(
            render_patch(
                &git,
                &PatchSource::Commit {
                    oid: "--all".into()
                }
            )
            .is_err()
        );
        assert!(render_patch(&git, &PatchSource::Commit { oid: "HEAD".into() }).is_err());
    }

    #[test]
    fn applying_to_the_index_stages_the_change() {
        let (_d1, one) = init_repo();
        commit_file(&one, "a.txt", "a\n", "base");
        write(&one, "a.txt", "a\nmore\n");
        let patch = render_patch(&one, &PatchSource::Worktree { staged: false }).unwrap();
        one.output(["checkout", "--", "a.txt"]).unwrap();
        apply_patch_bytes(&one, &patch, true).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&one.output(["diff", "--cached", "--name-only"]).unwrap())
                .trim(),
            "a.txt"
        );
    }
}
