//! Cloning and initialising repositories.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::error::{AppError, Result};
use crate::git::cli::{Git, GitOverrides};
use crate::git::validate;

/// A folder name for a clone, taken from the last part of the URL (`https://h/x/repo.git` →
/// `repo`). Only plain characters survive, so the name can never escape the chosen folder.
pub fn folder_name(url: &str) -> String {
    let trimmed = url.trim_end_matches(['/', '\\']);
    let last = trimmed
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".git");
    let clean: String = last
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() {
        "repository".into()
    } else {
        clean
    }
}

/// Clones `url` into `parent/<name>`, reporting git's progress lines. The destination must not
/// exist yet (or be empty), so a clone can never overwrite anything.
pub fn clone_into(
    parent: &Path,
    url: &str,
    overrides: GitOverrides,
    cancel: &AtomicBool,
    on_line: impl FnMut(&str),
) -> Result<PathBuf> {
    let url = validate::remote_url(url)?;
    let target = parent.join(folder_name(url));
    if target.exists()
        && std::fs::read_dir(&target)
            .map_err(AppError::git)?
            .next()
            .is_some()
    {
        return Err(AppError::Git(format!(
            "the folder {} already exists and is not empty",
            target.display()
        )));
    }
    let target_arg = target
        .to_str()
        .ok_or_else(|| AppError::Git("the destination path is not valid text".into()))?;
    let git = Git::new(parent).with_overrides(overrides);
    let result = git.stream_cancellable(
        ["clone", "--progress", "--", url, target_arg],
        on_line,
        cancel,
    );
    if let Err(e) = result {
        // A failed or cancelled clone leaves a half-written folder; remove only what we made.
        let _ = std::fs::remove_dir_all(&target);
        return Err(e);
    }
    Ok(target)
}

/// `git init` in an existing folder, with `main` as the first branch.
pub fn init_in(dir: &Path) -> Result<()> {
    if !dir.is_dir() {
        return Err(AppError::Git("that is not a folder".into()));
    }
    Git::new(dir).output(["init", "-q", "-b", "main"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    #[test]
    fn folder_names_are_plain_and_never_traverse() {
        assert_eq!(folder_name("https://github.com/a/perseus.git"), "perseus");
        assert_eq!(folder_name("git@github.com:a/perseus.git"), "perseus");
        assert_eq!(folder_name("https://example.com/a/b/"), "b");
        assert_eq!(folder_name("C:\\repos\\thing.git"), "thing");
        assert_eq!(folder_name("/srv/git/x"), "x");
        assert_eq!(folder_name("https://h/.."), "repository");
        assert_eq!(folder_name("https://h/%2e%2e"), "2e2e");
        assert_eq!(folder_name(""), "repository");
        assert_eq!(folder_name("https://h/a b$(touch pwned)"), "abtouchpwned");
        assert!(!folder_name("../../etc").contains('/'));
    }

    fn bare_with_commit() -> (tempfile::TempDir, String) {
        let (d, git) = init_repo();
        commit_file(&git, "a.txt", "hello\n", "first");
        let bare = tempfile::tempdir().unwrap();
        Git::new(bare.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        git.output(["push", "-q", bare.path().to_str().unwrap(), "main"])
            .unwrap();
        drop(d);
        let url = bare.path().to_str().unwrap().to_string();
        (bare, url)
    }

    #[test]
    fn clones_with_progress_and_refuses_to_overwrite() {
        let (_bare, url) = bare_with_commit();
        let parent = tempfile::tempdir().unwrap();
        let mut lines = Vec::new();
        let target = clone_into(
            parent.path(),
            &url,
            GitOverrides::default(),
            &AtomicBool::new(false),
            |l| lines.push(l.to_string()),
        )
        .unwrap();
        assert!(target.join("a.txt").exists());
        assert!(!lines.is_empty(), "clone should report progress");

        let again = clone_into(
            parent.path(),
            &url,
            GitOverrides::default(),
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(again.unwrap_err().to_string().contains("not empty"));
        assert!(
            target.join("a.txt").exists(),
            "the first clone is untouched"
        );
    }

    #[test]
    fn a_failed_clone_leaves_no_folder_behind() {
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("does-not-exist.git");
        let err = clone_into(
            parent.path(),
            missing.to_str().unwrap(),
            GitOverrides::default(),
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(err.is_err());
        assert!(!parent.path().join("does-not-exist").exists());
    }

    #[test]
    fn hostile_urls_are_rejected_before_git_runs() {
        let parent = tempfile::tempdir().unwrap();
        for bad in [
            "--upload-pack=evil",
            "ext::sh -c touch pwned",
            "-oProxyCommand=x",
            "",
        ] {
            let r = clone_into(
                parent.path(),
                bad,
                GitOverrides::default(),
                &AtomicBool::new(false),
                |_| {},
            );
            assert!(r.is_err(), "{bad:?} accepted");
        }
        assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
    }

    #[test]
    fn init_creates_a_repository_on_main() {
        let d = tempfile::tempdir().unwrap();
        init_in(d.path()).unwrap();
        let head = std::fs::read_to_string(d.path().join(".git/HEAD")).unwrap();
        assert!(head.contains("refs/heads/main"));
        assert!(init_in(&d.path().join("nope")).is_err());
    }
}
