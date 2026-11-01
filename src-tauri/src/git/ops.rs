//! Write operations. Each function validates its inputs, then runs one git command.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

fn paths(paths: &[String]) -> Result<Vec<&str>> {
    if paths.is_empty() {
        return Err(AppError::Git("no paths given".into()));
    }
    paths.iter().map(|p| validate::rel_path(p)).collect()
}

fn has_head(git: &Git) -> bool {
    git.output(["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

/// Stages additions, modifications and deletions for the given paths.
pub fn stage(git: &Git, files: &[String]) -> Result<()> {
    let files = paths(files)?;
    git.output(["add", "-A", "--"].into_iter().chain(files))?;
    Ok(())
}

pub fn unstage(git: &Git, files: &[String]) -> Result<()> {
    let files = paths(files)?;
    if has_head(git) {
        git.output(["restore", "--staged", "--"].into_iter().chain(files))?;
    } else {
        // No commits yet: there is no HEAD to restore from.
        git.output(
            ["rm", "--cached", "-r", "-q", "--"]
                .into_iter()
                .chain(files),
        )?;
    }
    Ok(())
}

/// Commits the index. The message goes over stdin, so it can be any length or content.
pub fn commit(git: &Git, message: &str, amend: bool) -> Result<()> {
    if message.trim().is_empty() {
        return Err(AppError::Git("commit message is empty".into()));
    }
    let mut args = vec!["commit", "-q", "--cleanup=strip", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    git.output_with_stdin(args, message.as_bytes())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SwitchTarget {
    Branch { name: String },
    Detached { oid: String },
}

pub fn switch(git: &Git, target: &SwitchTarget) -> Result<()> {
    match target {
        SwitchTarget::Branch { name } => {
            git.output(["switch", "-q", validate::ref_name(name)?])?;
        }
        SwitchTarget::Detached { oid } => {
            let oid = validate::oid(oid)?.to_string();
            git.output(["switch", "-q", "--detach", oid.as_str()])?;
        }
    }
    Ok(())
}

pub fn create_branch(git: &Git, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
    let name = validate::ref_name(name)?;
    let start = start.map(validate::oid).transpose()?.map(|o| o.to_string());
    let mut args: Vec<&str> = if checkout {
        vec!["switch", "-q", "-c", name]
    } else {
        vec!["branch", name]
    };
    if let Some(s) = &start {
        args.push(s);
    }
    git.output(args)?;
    Ok(())
}

/// A multi-step operation that stopped (usually on conflicts) and awaits a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Merge,
    CherryPick,
    Rebase,
    Revert,
}

impl Operation {
    fn command(self) -> &'static str {
        match self {
            Operation::Merge => "merge",
            Operation::CherryPick => "cherry-pick",
            Operation::Rebase => "rebase",
            Operation::Revert => "revert",
        }
    }
}

pub fn in_progress(git: &Git) -> Option<Operation> {
    let out = git.output(["rev-parse", "--absolute-git-dir"]).ok()?;
    let dir = PathBuf::from(String::from_utf8_lossy(&out).trim());
    // Check rebase first: a rebase stopped on a pick also leaves CHERRY_PICK_HEAD behind.
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        Some(Operation::Rebase)
    } else if dir.join("MERGE_HEAD").exists() {
        Some(Operation::Merge)
    } else if dir.join("CHERRY_PICK_HEAD").exists() {
        Some(Operation::CherryPick)
    } else if dir.join("REVERT_HEAD").exists() {
        Some(Operation::Revert)
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GitOp {
    Fetch,
    /// Fast-forward only: never creates a surprise merge commit.
    Pull,
    Push {
        #[serde(default)]
        set_upstream: bool,
        remote: Option<String>,
    },
    Merge {
        rev: String,
    },
    CherryPick {
        oid: String,
    },
    Rebase {
        onto: String,
    },
    Abort,
    Continue,
}

/// A commit id or ref name, never something that parses as an option.
fn rev_arg(rev: &str) -> Result<String> {
    match validate::oid(rev) {
        Ok(id) => Ok(id.to_string()),
        Err(_) => validate::ref_name(rev).map(str::to_string),
    }
}

fn current_branch(git: &Git) -> Result<String> {
    let out = git
        .output(["symbolic-ref", "--short", "-q", "HEAD"])
        .map_err(|_| AppError::Git("HEAD is detached; switch to a branch first".into()))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Runs a long-lived operation, forwarding progress lines. Returns git's stdout.
pub fn run(git: &Git, op: &GitOp, on_line: impl FnMut(&str)) -> Result<String> {
    let out = match op {
        GitOp::Fetch => git.stream(["fetch", "--progress", "--all"], on_line)?,
        GitOp::Pull => git.stream(["pull", "--progress", "--ff-only"], on_line)?,
        GitOp::Push {
            set_upstream,
            remote,
        } => {
            if *set_upstream {
                let remote = validate::remote_name(remote.as_deref().unwrap_or("origin"))?;
                let branch = current_branch(git)?;
                git.stream(
                    ["push", "--progress", "-u", remote, branch.as_str()],
                    on_line,
                )?
            } else {
                git.stream(["push", "--progress"], on_line)?
            }
        }
        GitOp::Merge { rev } => {
            let rev = rev_arg(rev)?;
            git.stream(["merge", "--no-edit", rev.as_str()], on_line)?
        }
        GitOp::CherryPick { oid } => {
            let oid = validate::oid(oid)?.to_string();
            git.stream(["cherry-pick", oid.as_str()], on_line)?
        }
        GitOp::Rebase { onto } => {
            let onto = rev_arg(onto)?;
            git.stream(["rebase", onto.as_str()], on_line)?
        }
        GitOp::Abort | GitOp::Continue => {
            let current = in_progress(git)
                .ok_or_else(|| AppError::Git("no operation is in progress".into()))?;
            let flag = if matches!(op, GitOp::Abort) {
                "--abort"
            } else {
                "--continue"
            };
            git.stream([current.command(), flag], on_line)?
        }
    };
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

#[cfg(test)]
mod op_tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn rev(git: &Git, r: &str) -> String {
        String::from_utf8(git.output(["rev-parse", r]).unwrap())
            .unwrap()
            .trim()
            .to_string()
    }

    fn read(git: &Git, rel: &str) -> String {
        std::fs::read_to_string(git.root().join(rel)).unwrap()
    }

    /// main and `other` both change f.txt differently after a common base.
    fn diverged() -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        commit_file(&git, "f.txt", "base\n", "base");
        git.output(["switch", "-q", "-c", "other"]).unwrap();
        commit_file(&git, "f.txt", "other\n", "other change");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "f.txt", "main\n", "main change");
        (d, git)
    }

    fn quiet(_: &str) {}

    #[test]
    fn merge_conflict_then_abort() {
        let (_d, git) = diverged();
        let err = run(
            &git,
            &GitOp::Merge {
                rev: "other".into(),
            },
            quiet,
        )
        .unwrap_err();
        assert!(err.to_string().contains("CONFLICT"), "{err}");
        assert_eq!(in_progress(&git), Some(Operation::Merge));

        run(&git, &GitOp::Abort, quiet).unwrap();
        assert_eq!(in_progress(&git), None);
        assert_eq!(read(&git, "f.txt"), "main\n");
    }

    #[test]
    fn merge_conflict_resolve_and_continue() {
        let (_d, git) = diverged();
        let _ = run(
            &git,
            &GitOp::Merge {
                rev: "other".into(),
            },
            quiet,
        );
        write(&git, "f.txt", "resolved\n");
        stage(&git, &["f.txt".to_string()]).unwrap();
        run(&git, &GitOp::Continue, quiet).unwrap();

        assert_eq!(in_progress(&git), None);
        let parents = git
            .output(["rev-list", "--parents", "-n1", "HEAD"])
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            3
        );
    }

    #[test]
    fn cherry_pick_applies_and_conflicts_abort() {
        let (_d, git) = diverged();
        let other = rev(&git, "other");
        let err = run(&git, &GitOp::CherryPick { oid: other.clone() }, quiet).unwrap_err();
        assert!(err.to_string().contains("CONFLICT") || err.to_string().contains("conflict"));
        assert_eq!(in_progress(&git), Some(Operation::CherryPick));
        run(&git, &GitOp::Abort, quiet).unwrap();
        assert_eq!(in_progress(&git), None);

        // A clean pick onto a different file.
        git.output(["switch", "-q", "-c", "side", "main~1"])
            .unwrap();
        commit_file(&git, "g.txt", "g\n", "add g");
        let side = rev(&git, "HEAD");
        git.output(["switch", "-q", "main"]).unwrap();
        run(&git, &GitOp::CherryPick { oid: side }, quiet).unwrap();
        assert_eq!(read(&git, "g.txt"), "g\n");
    }

    #[test]
    fn rebase_clean_conflict_abort_and_continue() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        git.output(["switch", "-q", "-c", "topic"]).unwrap();
        commit_file(&git, "t.txt", "t\n", "topic work");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "m.txt", "m\n", "main work");
        git.output(["switch", "-q", "topic"]).unwrap();

        run(
            &git,
            &GitOp::Rebase {
                onto: "main".into(),
            },
            quiet,
        )
        .unwrap();
        let merges = git
            .output(["rev-list", "--merges", "--count", "HEAD"])
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&merges).trim(), "0");
        assert_eq!(read(&git, "m.txt"), "m\n");

        // Conflicting rebase: abort restores, continue finishes.
        let (_d2, g2) = diverged();
        g2.output(["switch", "-q", "other"]).unwrap();
        assert!(
            run(
                &g2,
                &GitOp::Rebase {
                    onto: "main".into()
                },
                quiet
            )
            .is_err()
        );
        assert_eq!(in_progress(&g2), Some(Operation::Rebase));
        run(&g2, &GitOp::Abort, quiet).unwrap();
        assert_eq!(in_progress(&g2), None);

        assert!(
            run(
                &g2,
                &GitOp::Rebase {
                    onto: "main".into()
                },
                quiet
            )
            .is_err()
        );
        write(&g2, "f.txt", "resolved\n");
        stage(&g2, &["f.txt".to_string()]).unwrap();
        run(&g2, &GitOp::Continue, quiet).unwrap();
        assert_eq!(in_progress(&g2), None);
        assert_eq!(read(&g2, "f.txt"), "resolved\n");
    }

    #[test]
    fn continue_without_operation_is_an_error() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        assert!(run(&git, &GitOp::Continue, quiet).is_err());
        assert!(run(&git, &GitOp::Abort, quiet).is_err());
    }

    #[test]
    fn rejects_option_like_revisions() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        for rev in ["--abort", "-s", "--exec=touch pwned", "a..b"] {
            assert!(run(&git, &GitOp::Merge { rev: rev.into() }, quiet).is_err());
            assert!(run(&git, &GitOp::Rebase { onto: rev.into() }, quiet).is_err());
        }
        assert!(!git.root().join("pwned").exists());
    }

    #[test]
    fn push_pull_fetch_against_a_local_remote() {
        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let url = remote.path().to_str().unwrap().to_string();

        let (_d1, one) = init_repo();
        commit_file(&one, "a.txt", "a\n", "first");
        one.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        let mut lines = Vec::new();
        run(
            &one,
            &GitOp::Push {
                set_upstream: true,
                remote: None,
            },
            |l| lines.push(l.to_string()),
        )
        .unwrap();
        assert!(!lines.is_empty(), "push should report progress");

        // A second clone pushes a new commit; the first fetches and fast-forwards.
        let (_d2, two) = init_repo();
        two.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        two.output(["fetch", "-q", "origin"]).unwrap();
        two.output(["reset", "-q", "--hard", "origin/main"])
            .unwrap();
        commit_file(&two, "b.txt", "b\n", "second");
        two.output(["push", "-q", "origin", "main"]).unwrap();

        run(&one, &GitOp::Fetch, quiet).unwrap();
        assert!(rev(&one, "origin/main") != rev(&one, "HEAD"));
        run(&one, &GitOp::Pull, quiet).unwrap();
        assert_eq!(rev(&one, "origin/main"), rev(&one, "HEAD"));
        assert_eq!(read(&one, "b.txt"), "b\n");

        assert!(
            run(
                &one,
                &GitOp::Push {
                    set_upstream: true,
                    remote: Some("-o".into())
                },
                quiet
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;
    use crate::git::status;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn stage_unstage_commit_roundtrip() {
        let (_d, git) = init_repo();
        write(&git, "a.txt", "a\n");
        write(&git, "dir/b.txt", "b\n");

        stage(&git, &s(&["a.txt"])).unwrap();
        let st = status::read(&git).unwrap();
        assert_eq!(
            st.entries.iter().find(|e| e.path == "a.txt").unwrap().index,
            Some('A')
        );
        assert!(
            st.entries
                .iter()
                .find(|e| e.path == "dir/b.txt")
                .unwrap()
                .untracked
        );

        // Unstaging in a repo with no commits must work too.
        unstage(&git, &s(&["a.txt"])).unwrap();
        assert!(
            status::read(&git)
                .unwrap()
                .entries
                .iter()
                .all(|e| e.untracked)
        );

        stage(&git, &s(&["a.txt", "dir/b.txt"])).unwrap();
        commit(&git, "first\n\nwith body", false).unwrap();
        assert!(status::read(&git).unwrap().entries.is_empty());

        // Deletions are staged by `stage`.
        std::fs::remove_file(git.root().join("a.txt")).unwrap();
        stage(&git, &s(&["a.txt"])).unwrap();
        assert_eq!(status::read(&git).unwrap().entries[0].index, Some('D'));
        unstage(&git, &s(&["a.txt"])).unwrap();
        assert_eq!(status::read(&git).unwrap().entries[0].worktree, Some('D'));

        let log = git.output(["log", "-1", "--format=%B"]).unwrap();
        assert!(String::from_utf8_lossy(&log).contains("with body"));
    }

    #[test]
    fn commit_rejects_empty_message_and_supports_amend() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "one");
        assert!(commit(&git, "  \n", false).is_err());

        write(&git, "a.txt", "a2\n");
        stage(&git, &s(&["a.txt"])).unwrap();
        commit(&git, "one (amended)", true).unwrap();
        let count = git.output(["rev-list", "--count", "HEAD"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&count).trim(), "1");
    }

    #[test]
    fn hostile_inputs_never_reach_git() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "one");
        assert!(stage(&git, &s(&["../outside"])).is_err());
        assert!(stage(&git, &s(&[])).is_err());
        assert!(
            switch(
                &git,
                &SwitchTarget::Branch {
                    name: "--orphan=x".into()
                }
            )
            .is_err()
        );
        assert!(create_branch(&git, "-d", None, false).is_err());
        assert!(create_branch(&git, "ok", Some("HEAD"), false).is_err());
    }

    #[test]
    fn switch_and_create_branches() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "one");
        let head = String::from_utf8(git.output(["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .to_string();

        create_branch(&git, "feature/x", Some(&head), true).unwrap();
        assert_eq!(
            status::read(&git).unwrap().branch.as_deref(),
            Some("feature/x")
        );
        switch(
            &git,
            &SwitchTarget::Branch {
                name: "main".into(),
            },
        )
        .unwrap();
        assert_eq!(status::read(&git).unwrap().branch.as_deref(), Some("main"));
        switch(&git, &SwitchTarget::Detached { oid: head }).unwrap();
        assert_eq!(status::read(&git).unwrap().branch, None);
    }
}
