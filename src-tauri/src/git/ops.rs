//! Write operations. Each function validates its inputs, then runs one git command.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::maintenance;
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
    commit_with(git, message, amend, false)
}

/// Like [`commit`]; `no_verify` skips the pre-commit and commit-msg hooks.
pub fn commit_with(git: &Git, message: &str, amend: bool, no_verify: bool) -> Result<()> {
    if message.trim().is_empty() {
        return Err(AppError::Git("commit message is empty".into()));
    }
    let mut args = vec!["commit", "-q", "--cleanup=strip", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if no_verify {
        args.push("--no-verify");
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

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullMode {
    #[default]
    FfOnly,
    Merge,
    Rebase,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GitOp {
    Fetch {
        /// Also forget remote-tracking branches that no longer exist on the remote.
        #[serde(default)]
        prune: bool,
    },
    /// Fast-forward only unless a mode is chosen: never a surprise merge commit by default.
    Pull {
        #[serde(default)]
        mode: PullMode,
    },
    Push {
        #[serde(default)]
        set_upstream: bool,
        remote: Option<String>,
        /// Overwrite the remote branch, but only if nobody else pushed since we last fetched.
        #[serde(default)]
        force_with_lease: bool,
        #[serde(default)]
        tags: bool,
    },
    Merge {
        rev: String,
    },
    CherryPick {
        oid: String,
    },
    /// Several commits, applied in the order given (oldest first). With a `squash` message they
    /// become a single commit instead of one each.
    CherryPickMany {
        oids: Vec<String>,
        #[serde(default)]
        squash: Option<String>,
    },
    Rebase {
        onto: String,
    },
    Abort,
    Continue,
    /// Upkeep of the repository itself: gc, commit-graph, integrity check, stale remote branches.
    Maintenance {
        task: maintenance::Task,
    },
}

/// A commit id or ref name, never something that parses as an option.
fn rev_arg(rev: &str) -> Result<String> {
    match validate::oid(rev) {
        Ok(id) => Ok(id.to_string()),
        Err(_) => validate::ref_name(rev).map(str::to_string),
    }
}

/// Most commits one cherry-pick may take; the list ends up on a command line.
const MAX_PICKS: usize = 500;

/// The commits to pick as validated full ids in the order given, without repeats. Merge commits
/// are refused here with a clear message: git would stop on them wanting to know which parent to follow.
fn pick_list(git: &Git, oids: &[String]) -> Result<Vec<String>> {
    let mut list: Vec<String> = Vec::new();
    for oid in oids {
        let oid = validate::oid(oid)?.to_string();
        if !list.contains(&oid) {
            list.push(oid);
        }
    }
    if list.is_empty() {
        return Err(AppError::Git("no commits to cherry-pick".into()));
    }
    if list.len() > MAX_PICKS {
        return Err(AppError::Git(format!(
            "cherry-picking more than {MAX_PICKS} commits at once is not supported"
        )));
    }
    let mut args = vec![
        "rev-list".to_string(),
        "--no-walk=unsorted".into(),
        "--parents".into(),
    ];
    args.extend(list.iter().cloned());
    let parents = git.output(args)?;
    for line in String::from_utf8_lossy(&parents).lines() {
        let mut fields = line.split_whitespace();
        if let (Some(oid), true) = (fields.next(), fields.count() > 1) {
            return Err(AppError::Git(format!(
                "{} is a merge commit; pick the commits it merged instead",
                &oid[..oid.len().min(7)]
            )));
        }
    }
    Ok(list)
}

fn current_branch(git: &Git) -> Result<String> {
    let out = git
        .output(["symbolic-ref", "--short", "-q", "HEAD"])
        .map_err(|_| AppError::Git("HEAD is detached; switch to a branch first".into()))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Runs a long-lived operation, forwarding progress lines. Returns git's stdout.
pub fn run(git: &Git, op: &GitOp, on_line: impl FnMut(&str)) -> Result<String> {
    run_cancellable(git, op, &AtomicBool::new(false), on_line)
}

/// Like [`run`], but setting `cancel` stops the operation (see `Git::stream_cancellable`).
pub fn run_cancellable(
    git: &Git,
    op: &GitOp,
    cancel: &AtomicBool,
    on_line: impl FnMut(&str),
) -> Result<String> {
    let out = match op {
        GitOp::Fetch { prune } => {
            let mut args = vec!["fetch", "--progress", "--all"];
            if *prune {
                args.push("--prune");
            }
            git.stream_cancellable(args, on_line, cancel)?
        }
        GitOp::Pull { mode } => {
            let mut args = vec!["pull", "--progress"];
            match mode {
                PullMode::FfOnly => args.push("--ff-only"),
                PullMode::Merge => args.extend(["--no-rebase", "--no-edit"]),
                PullMode::Rebase => args.push("--rebase"),
            }
            git.stream_cancellable(args, on_line, cancel)?
        }
        GitOp::Push {
            set_upstream,
            remote,
            force_with_lease,
            tags,
        } => {
            let mut args = vec!["push", "--progress"];
            if *force_with_lease {
                args.push("--force-with-lease");
            }
            if *tags {
                args.push("--tags");
            }
            let upstream_args;
            if *set_upstream {
                let remote = validate::remote_name(remote.as_deref().unwrap_or("origin"))?;
                let branch = current_branch(git)?;
                upstream_args = ["-u".to_string(), remote.to_string(), branch];
                args.extend(upstream_args.iter().map(String::as_str));
            } else if let Some(remote) = remote {
                args.push(validate::remote_name(remote)?);
            }
            git.stream_cancellable(args, on_line, cancel)?
        }
        GitOp::Merge { rev } => {
            let rev = rev_arg(rev)?;
            git.stream_cancellable(["merge", "--no-edit", rev.as_str()], on_line, cancel)?
        }
        GitOp::CherryPick { oid } => {
            let oid = validate::oid(oid)?.to_string();
            git.stream_cancellable(["cherry-pick", oid.as_str()], on_line, cancel)?
        }
        GitOp::CherryPickMany { oids, squash } => {
            let oids = pick_list(git, oids)?;
            let message = squash.as_deref().map(str::trim).filter(|m| !m.is_empty());
            let mut args = vec!["cherry-pick".to_string()];
            if message.is_some() {
                args.push("--no-commit".into());
            }
            args.extend(oids);
            match message {
                None => git.stream_cancellable(args, on_line, cancel)?,
                Some(message) => {
                    if message.contains('\0') {
                        return Err(AppError::Git("invalid commit message".into()));
                    }
                    let mut on_line = on_line;
                    git.stream_cancellable(args, &mut on_line, cancel).map_err(|e| {
                        AppError::Git(format!(
                            "{e}\n\nThese commits are being combined into one: once the conflicts are resolved and the cherry-pick is continued, commit the staged result."
                        ))
                    })?;
                    git.stream_cancellable(["commit", "-m", message], &mut on_line, cancel)?
                }
            }
        }
        GitOp::Rebase { onto } => {
            let onto = rev_arg(onto)?;
            git.stream_cancellable(["rebase", onto.as_str()], on_line, cancel)?
        }
        GitOp::Maintenance { task } => maintenance::run(git, *task, on_line, cancel)?,
        GitOp::Abort | GitOp::Continue => {
            let current = in_progress(git)
                .ok_or_else(|| AppError::Git("no operation is in progress".into()))?;
            let flag = if matches!(op, GitOp::Abort) {
                "--abort"
            } else {
                "--continue"
            };
            git.stream_cancellable([current.command(), flag], on_line, cancel)?
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

    /// `main` has `base`; `feature` adds f1, f2 and f3 (each its own file) on top of it.
    fn with_feature() -> (tempfile::TempDir, Git, Vec<String>) {
        let (d, git) = init_repo();
        commit_file(&git, "base.txt", "base\n", "base");
        git.output(["switch", "-q", "-c", "feature"]).unwrap();
        let mut ids = Vec::new();
        for n in ["f1", "f2", "f3"] {
            commit_file(&git, &format!("{n}.txt"), &format!("{n}\n"), n);
            ids.push(rev(&git, "HEAD"));
        }
        git.output(["switch", "-q", "main"]).unwrap();
        (d, git, ids)
    }

    fn subjects(git: &Git, n: usize) -> Vec<String> {
        let out = git
            .output(["log", &format!("-{n}"), "--format=%s"])
            .unwrap();
        String::from_utf8_lossy(&out)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn several_commits_are_picked_in_the_order_given() {
        let (_d, git, ids) = with_feature();
        let op = GitOp::CherryPickMany {
            oids: vec![ids[2].clone(), ids[0].clone(), ids[2].clone()],
            squash: None,
        };
        run(&git, &op, quiet).unwrap();
        // f3 first, then f1; the repeated id was ignored.
        assert_eq!(subjects(&git, 3), ["f1", "f3", "base"]);
        assert!(!git.root().join("f2.txt").exists());
    }

    #[test]
    fn several_commits_can_be_combined_into_one() {
        let (_d, git, ids) = with_feature();
        let op = GitOp::CherryPickMany {
            oids: ids.clone(),
            squash: Some("  Three features in one  ".into()),
        };
        run(&git, &op, quiet).unwrap();
        assert_eq!(subjects(&git, 2), ["Three features in one", "base"]);
        for n in ["f1", "f2", "f3"] {
            assert!(git.root().join(format!("{n}.txt")).exists(), "{n}");
        }
        assert_eq!(in_progress(&git), None);
    }

    #[test]
    fn a_conflict_in_the_middle_stops_there_and_continues_with_the_rest() {
        let (_d, git, ids) = with_feature();
        // Make f2 conflict by giving main a different f2.txt.
        commit_file(&git, "f2.txt", "mine\n", "my f2");
        let op = GitOp::CherryPickMany {
            oids: ids.clone(),
            squash: None,
        };
        assert!(run(&git, &op, quiet).is_err());
        assert_eq!(in_progress(&git), Some(Operation::CherryPick));
        assert_eq!(
            subjects(&git, 2),
            ["f1", "my f2"],
            "f1 landed before the stop"
        );

        write(&git, "f2.txt", "resolved\n");
        stage(&git, &["f2.txt".to_string()]).unwrap();
        run(&git, &GitOp::Continue, quiet).unwrap();
        assert_eq!(in_progress(&git), None);
        assert_eq!(
            subjects(&git, 3),
            ["f3", "f2", "f1"],
            "the rest was picked after continuing"
        );
    }

    #[test]
    fn a_conflicted_pick_can_be_abandoned_as_a_whole() {
        let (_d, git, ids) = with_feature();
        commit_file(&git, "f2.txt", "mine\n", "my f2");
        let before = rev(&git, "HEAD");
        let op = GitOp::CherryPickMany {
            oids: ids.clone(),
            squash: None,
        };
        assert!(run(&git, &op, quiet).is_err());
        run(&git, &GitOp::Abort, quiet).unwrap();
        assert_eq!(rev(&git, "HEAD"), before, "even f1 is taken back");
        assert_eq!(in_progress(&git), None);
    }

    #[test]
    fn merge_commits_and_bad_lists_are_refused_before_anything_changes() {
        let (_d, git, ids) = with_feature();
        git.output(["merge", "-q", "--no-ff", "-m", "merge feature", "feature"])
            .unwrap();
        let merge = rev(&git, "HEAD");
        git.output(["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        // Re-create the merge commit on another branch so it can be named while main stays put.
        let tip = rev(&git, "HEAD");
        let pick =
            |oids: Vec<String>| run(&git, &GitOp::CherryPickMany { oids, squash: None }, quiet);
        let err = pick(vec![ids[0].clone(), merge]).unwrap_err();
        assert!(err.to_string().contains("merge commit"), "{err}");
        assert_eq!(rev(&git, "HEAD"), tip, "f1 was not picked either");
        assert!(pick(vec![]).is_err());
        assert!(pick(vec!["main".into()]).is_err());
        assert!(pick(vec!["--all".into()]).is_err());
        assert!(
            run(
                &git,
                &GitOp::CherryPickMany {
                    oids: ids,
                    squash: Some("bad\0message".into())
                },
                quiet
            )
            .is_err()
        );
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

    /// Two clones of one bare remote: `one` is the repo under test, `two` pushes behind its back.
    fn two_clones() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        tempfile::TempDir,
        Git,
        Git,
    ) {
        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let url = remote.path().to_str().unwrap().to_string();
        let (d1, one) = init_repo();
        commit_file(&one, "a.txt", "a\n", "first");
        one.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        one.output(["push", "-q", "-u", "origin", "main"]).unwrap();
        let (d2, two) = init_repo();
        two.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        two.output(["fetch", "-q", "origin"]).unwrap();
        two.output(["reset", "-q", "--hard", "origin/main"])
            .unwrap();
        (remote, d1, d2, one, two)
    }

    #[test]
    fn pull_modes_differ_when_history_diverges() {
        let (_r, _d1, _d2, one, two) = two_clones();
        commit_file(&two, "b.txt", "b\n", "theirs");
        two.output(["push", "-q", "origin", "main"]).unwrap();
        commit_file(&one, "c.txt", "c\n", "mine");

        // Fast-forward only refuses, and leaves everything as it was.
        let before = rev(&one, "HEAD");
        assert!(
            run(
                &one,
                &GitOp::Pull {
                    mode: PullMode::FfOnly
                },
                quiet
            )
            .is_err()
        );
        assert_eq!(rev(&one, "HEAD"), before);

        // Rebase replays our commit on top of theirs: a straight line.
        run(
            &one,
            &GitOp::Pull {
                mode: PullMode::Rebase,
            },
            quiet,
        )
        .unwrap();
        let parents = one
            .output(["rev-list", "--parents", "-n1", "HEAD"])
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            2,
            "no merge commit"
        );
        assert_eq!(read(&one, "b.txt"), "b\n");
        assert_eq!(read(&one, "c.txt"), "c\n");
    }

    #[test]
    fn pull_with_merge_mode_creates_a_merge_commit() {
        let (_r, _d1, _d2, one, two) = two_clones();
        commit_file(&two, "b.txt", "b\n", "theirs");
        two.output(["push", "-q", "origin", "main"]).unwrap();
        commit_file(&one, "c.txt", "c\n", "mine");
        run(
            &one,
            &GitOp::Pull {
                mode: PullMode::Merge,
            },
            quiet,
        )
        .unwrap();
        let parents = one
            .output(["rev-list", "--parents", "-n1", "HEAD"])
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            3,
            "a merge commit"
        );
    }

    #[test]
    fn force_with_lease_protects_other_peoples_work() {
        let (_r, _d1, _d2, one, two) = two_clones();
        // `one` rewrites its last commit; a plain push is rejected as non-fast-forward.
        one.output(["commit", "-q", "--amend", "-m", "rewritten"])
            .unwrap();
        let plain = GitOp::Push {
            set_upstream: false,
            remote: None,
            force_with_lease: false,
            tags: false,
        };
        assert!(run(&one, &plain, quiet).is_err());

        // With the lease it succeeds, because nobody pushed since our last fetch.
        let lease = GitOp::Push {
            set_upstream: false,
            remote: None,
            force_with_lease: true,
            tags: false,
        };
        run(&one, &lease, quiet).unwrap();

        // Now `two` pushes something new; the lease notices that `one` has not seen it.
        two.output(["fetch", "-q", "origin"]).unwrap();
        two.output(["reset", "-q", "--hard", "origin/main"])
            .unwrap();
        commit_file(&two, "b.txt", "b\n", "theirs");
        two.output(["push", "-q", "origin", "main"]).unwrap();
        one.output(["commit", "-q", "--amend", "-m", "rewritten again"])
            .unwrap();
        assert!(
            run(&one, &lease, quiet).is_err(),
            "the lease must refuse to overwrite unseen work"
        );
    }

    #[test]
    fn push_can_include_tags() {
        let (remote, _d1, _d2, one, _two) = two_clones();
        one.output(["tag", "v9"]).unwrap();
        let op = GitOp::Push {
            set_upstream: false,
            remote: None,
            force_with_lease: false,
            tags: true,
        };
        run(&one, &op, quiet).unwrap();
        assert!(
            Git::new(remote.path())
                .output(["rev-parse", "-q", "--verify", "refs/tags/v9"])
                .is_ok()
        );
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
                force_with_lease: false,
                tags: false,
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

        run(&one, &GitOp::Fetch { prune: false }, quiet).unwrap();
        assert!(rev(&one, "origin/main") != rev(&one, "HEAD"));
        run(
            &one,
            &GitOp::Pull {
                mode: PullMode::FfOnly,
            },
            quiet,
        )
        .unwrap();
        assert_eq!(rev(&one, "origin/main"), rev(&one, "HEAD"));
        assert_eq!(read(&one, "b.txt"), "b\n");

        assert!(
            run(
                &one,
                &GitOp::Push {
                    set_upstream: true,
                    remote: Some("-o".into()),
                    force_with_lease: false,
                    tags: false,
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
