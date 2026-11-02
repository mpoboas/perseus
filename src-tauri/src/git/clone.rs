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

/// `git init` in an existing folder, with `branch` (default `main`) as the first branch.
pub fn init_in(dir: &Path, branch: Option<&str>) -> Result<()> {
    if !dir.is_dir() {
        return Err(AppError::Git("that is not a folder".into()));
    }
    let branch = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => validate::ref_name(b)?,
        None => "main",
    };
    Git::new(dir).output(["init", "-q", "-b", branch])?;
    Ok(())
}

/// The message of the first commit of a new repository.
const FIRST_COMMIT: &str = "Initial commit";

/// A folder name for a new repository, as typed. Everything that could leave the chosen parent, or
/// that Windows would not accept, is refused rather than quietly changed.
pub fn local_folder_name(name: &str) -> Result<String> {
    let name = name.trim();
    let reserved = {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|p| {
                stem.strip_prefix(p)
                    .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit() && n != "0")
            })
    };
    let bad = name.is_empty()
        || name.chars().count() > 100
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        || reserved;
    if bad {
        Err(AppError::Git(
            "that name cannot be used for a folder (no slashes or special characters, no trailing dot)".into(),
        ))
    } else {
        Ok(name.to_string())
    }
}

/// Creates `parent/<name>` as a new repository whose first branch is `branch`. With `readme` the
/// first commit holds a README named after the project; with `empty_first_commit` it is empty (a
/// repository to publish needs a commit to push). The folder must not exist yet or be empty, and
/// whatever this made is removed again if anything fails.
pub fn create_local(
    parent: &Path,
    name: &str,
    description: &str,
    branch: Option<&str>,
    readme: bool,
    empty_first_commit: bool,
    overrides: GitOverrides,
) -> Result<PathBuf> {
    let name = local_folder_name(name)?;
    let target = parent.join(&name);
    let existed = target.exists();
    if existed
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
    let made = (|| -> Result<()> {
        std::fs::create_dir_all(&target).map_err(AppError::git)?;
        init_in(&target, branch)?;
        let git = Git::new(&target).with_overrides(overrides);
        if readme {
            let mut text = format!("# {name}\n");
            let description = description.trim();
            if !description.is_empty() {
                text.push_str(&format!("\n{description}\n"));
            }
            std::fs::write(target.join("README.md"), text).map_err(AppError::git)?;
            git.output(["add", "--", "README.md"])?;
        }
        if readme || empty_first_commit {
            git.output(["commit", "-q", "--allow-empty", "-m", FIRST_COMMIT])
                .map_err(|e| {
                    AppError::Git(format!(
                        "could not make the first commit: {e}. Set your name and email in a profile."
                    ))
                })?;
        }
        Ok(())
    })();
    if let Err(e) = made {
        if existed {
            // The folder was there already (and empty): empty it again rather than delete it.
            let _ = std::fs::remove_dir_all(target.join(".git"));
            let _ = std::fs::remove_file(target.join("README.md"));
        } else {
            let _ = std::fs::remove_dir_all(&target);
        }
        return Err(e);
    }
    Ok(target)
}

/// Points `origin` at `url` and pushes the current branch there, setting it as the upstream.
pub fn publish(git: &Git, url: &str, cancel: &AtomicBool, on_line: impl FnMut(&str)) -> Result<()> {
    let url = validate::remote_url(url)?;
    git.output(["remote", "add", "origin", "--", url])?;
    let branch = git.output(["symbolic-ref", "--short", "-q", "HEAD"])?;
    let branch = String::from_utf8_lossy(&branch).trim().to_string();
    validate::ref_name(&branch)?;
    git.stream_cancellable(
        ["push", "--progress", "-u", "origin", branch.as_str()],
        on_line,
        cancel,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    #[test]
    fn folder_names_for_new_repositories_are_checked_not_rewritten() {
        for ok in ["perseus", "My Project", "a.b-c_d", "x1", "日本語", "COM10"] {
            assert_eq!(local_folder_name(ok).unwrap(), ok);
        }
        assert_eq!(local_folder_name("  padded  ").unwrap(), "padded");
        for bad in [
            "",
            "  ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "..\\x",
            "C:",
            "x:y",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a|b",
            "-rf",
            "ends.",
            "tab\there",
            "nl\nx",
            "CON",
            "con.txt",
            "NUL",
            "COM1",
            "lpt9",
            &"n".repeat(101),
        ] {
            assert!(local_folder_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_new_repository_gets_a_readme_commit_named_after_it() {
        let parent = tempfile::tempdir().unwrap();
        let target = create_local(
            parent.path(),
            "demo",
            "A demo\nproject",
            Some("trunk"),
            true,
            false,
            config(),
        )
        .unwrap();
        let git = Git::new(&target);
        let log = git.output(["log", "--format=%s"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&log).trim(), "Initial commit");
        let readme = std::fs::read_to_string(target.join("README.md")).unwrap();
        assert_eq!(readme.replace("\r\n", "\n"), "# demo\n\nA demo\nproject\n");
        let branch = git.output(["symbolic-ref", "--short", "HEAD"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&branch).trim(), "trunk");
    }

    /// Identity for the commits these tests make, the way a profile supplies it.
    fn config() -> GitOverrides {
        GitOverrides {
            config: vec![
                ("user.name".into(), "Tester".into()),
                ("user.email".into(), "tester@example.com".into()),
                ("commit.gpgsign".into(), "false".into()),
            ],
            env: Vec::new(),
        }
    }

    #[test]
    fn without_a_readme_the_repository_is_empty_unless_it_is_to_be_published() {
        let parent = tempfile::tempdir().unwrap();
        let empty = create_local(parent.path(), "bare", "", None, false, false, config()).unwrap();
        assert!(
            Git::new(&empty).output(["rev-parse", "HEAD"]).is_err(),
            "no commit yet"
        );
        assert!(!empty.join("README.md").exists());

        let to_publish =
            create_local(parent.path(), "pub", "", None, false, true, config()).unwrap();
        let log = Git::new(&to_publish)
            .output(["log", "--format=%s"])
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&log).trim(), "Initial commit");
        assert!(!to_publish.join("README.md").exists());
    }

    #[test]
    fn an_existing_folder_is_never_overwritten_and_an_empty_one_is_reused() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("full")).unwrap();
        std::fs::write(parent.path().join("full").join("keep.txt"), "mine").unwrap();
        let err = create_local(parent.path(), "full", "", None, true, false, config()).unwrap_err();
        assert!(err.to_string().contains("not empty"));
        assert!(parent.path().join("full").join("keep.txt").exists());
        assert!(!parent.path().join("full").join(".git").exists());

        std::fs::create_dir(parent.path().join("empty")).unwrap();
        create_local(parent.path(), "empty", "", None, true, false, config()).unwrap();
        assert!(parent.path().join("empty").join(".git").exists());
    }

    #[test]
    fn a_failure_removes_what_was_made_and_names_the_likely_cause() {
        let parent = tempfile::tempdir().unwrap();
        // No identity anywhere: git refuses the first commit.
        let no_identity = GitOverrides {
            config: Vec::new(),
            env: vec![
                ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_AUTHOR_NAME".into(), String::new()),
                ("GIT_AUTHOR_EMAIL".into(), String::new()),
                ("GIT_COMMITTER_NAME".into(), String::new()),
                ("GIT_COMMITTER_EMAIL".into(), String::new()),
                ("EMAIL".into(), String::new()),
            ],
        };
        let err = create_local(parent.path(), "nope", "", None, true, false, no_identity);
        if let Err(e) = err {
            assert!(e.to_string().contains("first commit"), "{e}");
            assert!(
                !parent.path().join("nope").exists(),
                "the folder it made is removed again"
            );
        }
        // (Where git can still work out an identity from the machine, the commit simply succeeds.)
    }

    #[test]
    fn publishing_pushes_the_first_commit_and_tracks_the_remote_branch() {
        let parent = tempfile::tempdir().unwrap();
        let target = create_local(
            parent.path(),
            "app",
            "",
            Some("main"),
            true,
            false,
            config(),
        )
        .unwrap();
        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let url = remote.path().to_string_lossy().into_owned();

        let git = Git::new(&target);
        publish(&git, &url, &AtomicBool::new(false), |_| {}).unwrap();

        let origin = git.output(["remote", "get-url", "origin"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&origin).trim(), url);
        let upstream = git
            .output(["rev-parse", "--abbrev-ref", "main@{upstream}"])
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&upstream).trim(), "origin/main");
        let pushed = Git::new(remote.path())
            .output(["log", "--format=%s", "main"])
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&pushed).trim(), "Initial commit");
    }

    #[test]
    fn publishing_refuses_hostile_addresses() {
        let parent = tempfile::tempdir().unwrap();
        let target = create_local(parent.path(), "app", "", None, true, false, config()).unwrap();
        let git = Git::new(&target);
        for bad in ["--upload-pack=calc", "ext::sh -c calc", "", "x\ny"] {
            assert!(
                publish(&git, bad, &AtomicBool::new(false), |_| {}).is_err(),
                "{bad:?}"
            );
        }
        assert!(
            git.output(["remote"]).unwrap().is_empty(),
            "no remote was added"
        );
    }

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
        init_in(d.path(), None).unwrap();
        let head = std::fs::read_to_string(d.path().join(".git/HEAD")).unwrap();
        assert!(head.contains("refs/heads/main"));
        assert!(init_in(&d.path().join("nope"), None).is_err());
    }
}
