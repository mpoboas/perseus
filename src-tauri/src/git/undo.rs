//! Undo and redo for moves of local branches.
//!
//! The app takes a [`Snapshot`] (which branch is checked out and where every local branch points)
//! before and after each action. Undoing puts the branches back as they were. Only local refs are
//! touched: nothing that was pushed or fetched is ever rewound, and uncommitted work is never
//! thrown away (a move that would overwrite it is refused by git).

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

const ZERO: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BranchTip {
    pub name: String,
    pub oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    /// The checked-out branch, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// The commit HEAD points at (`None` before the first commit).
    pub head: Option<String>,
    /// Every local branch, sorted by name.
    pub branches: Vec<BranchTip>,
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

pub fn snapshot(git: &Git) -> Result<Snapshot> {
    let branch = Some(text(
        git.output_allowing(["symbolic-ref", "-q", "--short", "HEAD"], &[0, 1])?,
    ))
    .filter(|b| !b.is_empty());
    let head = Some(text(
        git.output_allowing(["rev-parse", "-q", "--verify", "HEAD"], &[0, 1])?,
    ))
    .filter(|h| !h.is_empty());
    let listing = text(git.output([
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        "refs/heads",
    ])?);
    let mut branches: Vec<BranchTip> = listing
        .lines()
        .filter_map(|line| {
            let (name, oid) = line.split_once('\t')?;
            Some(BranchTip {
                name: name.strip_prefix("refs/heads/")?.to_string(),
                oid: oid.to_string(),
            })
        })
        .collect();
    branches.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Snapshot {
        branch,
        head,
        branches,
    })
}

/// A merge, rebase, cherry-pick or revert that is waiting for the user must be finished first:
/// moving branches underneath it would leave the repository in a state nobody can reason about.
fn operation_in_progress(git: &Git) -> Result<bool> {
    let dir = text(git.output(["rev-parse", "--absolute-git-dir"])?);
    let dir = std::path::Path::new(&dir);
    Ok([
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .any(|name| dir.join(name).exists()))
}

fn check(target: &Snapshot) -> Result<()> {
    for tip in &target.branches {
        validate::ref_name(&tip.name)?;
        validate::oid(&tip.oid)?;
    }
    if let Some(b) = &target.branch {
        validate::ref_name(b)?;
    }
    if let Some(h) = &target.head {
        validate::oid(h)?;
    }
    Ok(())
}

/// Puts the local branches and HEAD back as `target` describes.
///
/// With `keep_changes` the checked-out branch is moved with `reset --soft` (an undone commit keeps
/// its changes staged); otherwise with `reset --keep`, which also restores the files but refuses
/// to overwrite anything uncommitted.
pub fn restore(git: &Git, target: &Snapshot, keep_changes: bool) -> Result<()> {
    check(target)?;
    if operation_in_progress(git)? {
        return Err(AppError::Git(
            "Finish or abort the merge, rebase, cherry-pick or revert in progress first".into(),
        ));
    }
    let current = snapshot(git)?;
    let tip_in = |snap: &Snapshot, name: &str| {
        snap.branches
            .iter()
            .find(|t| t.name == name)
            .map(|t| t.oid.clone())
    };

    // 1. Branches that were deleted come back (at the commit they had).
    for tip in &target.branches {
        if tip_in(&current, &tip.name).is_none() {
            git.output([
                "update-ref",
                "-m",
                "perseus: undo",
                &format!("refs/heads/{}", tip.name),
                &tip.oid,
                ZERO,
            ])?;
        }
    }

    // 2. The checked-out branch (or detached commit) changes first, so no branch that must move
    //    or disappear is still checked out.
    if target.branch != current.branch {
        match (&target.branch, &target.head) {
            (Some(branch), _) => {
                git.output(["switch", branch])?;
            }
            (None, Some(head)) => {
                git.output(["switch", "--detach", head])?;
            }
            (None, None) => {}
        }
    }

    // 3. Every other branch goes back to its old tip; branches that did not exist are removed.
    let now = snapshot(git)?;
    for tip in &target.branches {
        if target.branch.as_deref() == Some(tip.name.as_str()) {
            continue;
        }
        if let Some(old) = tip_in(&now, &tip.name).filter(|old| *old != tip.oid) {
            git.output([
                "update-ref",
                "-m",
                "perseus: undo",
                &format!("refs/heads/{}", tip.name),
                &tip.oid,
                &old,
            ])?;
        }
    }
    for tip in &now.branches {
        let wanted = target.branches.iter().any(|t| t.name == tip.name);
        if !wanted && now.branch.as_deref() != Some(tip.name.as_str()) {
            git.output([
                "update-ref",
                "-d",
                &format!("refs/heads/{}", tip.name),
                &tip.oid,
            ])?;
        }
    }

    // 4. The commit HEAD itself points at.
    let now = snapshot(git)?;
    if let Some(head) = target
        .head
        .as_ref()
        .filter(|h| now.head.as_ref() != Some(*h))
    {
        git.output([
            "reset",
            if keep_changes { "--soft" } else { "--keep" },
            head,
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn head(git: &Git) -> String {
        text(git.output(["rev-parse", "HEAD"]).unwrap())
    }

    #[test]
    fn undoing_a_commit_keeps_its_changes_staged_and_redo_restores_it() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");
        let before = snapshot(&git).unwrap();
        commit_file(&git, "b.txt", "b\n", "second");
        let after = snapshot(&git).unwrap();
        assert_ne!(before, after);

        restore(&git, &before, true).unwrap();
        assert_eq!(snapshot(&git).unwrap(), before);
        let status = text(git.output(["status", "--porcelain"]).unwrap());
        assert_eq!(status, "A  b.txt", "the undone commit's file is staged");

        restore(&git, &after, true).unwrap();
        assert_eq!(snapshot(&git).unwrap(), after);
        assert_eq!(text(git.output(["status", "--porcelain"]).unwrap()), "");
    }

    #[test]
    fn undoing_a_merge_restores_the_files_too() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        git.output(["switch", "-q", "-c", "topic"]).unwrap();
        commit_file(&git, "t.txt", "t\n", "topic work");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "m.txt", "m\n", "main work");
        let before = snapshot(&git).unwrap();
        git.output(["merge", "-q", "--no-ff", "-m", "merge topic", "topic"])
            .unwrap();
        assert!(git.root().join("t.txt").exists());

        restore(&git, &before, false).unwrap();
        assert_eq!(snapshot(&git).unwrap(), before);
        assert!(
            !git.root().join("t.txt").exists(),
            "the merged file is gone again"
        );
    }

    #[test]
    fn checkouts_and_branch_creation_and_deletion_are_undone() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        let start = snapshot(&git).unwrap();

        git.output(["switch", "-q", "-c", "feature"]).unwrap();
        commit_file(&git, "f.txt", "f\n", "feature work");
        let on_feature = snapshot(&git).unwrap();
        restore(&git, &start, false).unwrap();
        assert_eq!(
            snapshot(&git).unwrap(),
            start,
            "back on main, the new branch removed"
        );

        // Redo brings the branch back at its old commit and checks it out.
        restore(&git, &on_feature, false).unwrap();
        assert_eq!(snapshot(&git).unwrap(), on_feature);

        // Deleting a branch can be undone.
        git.output(["switch", "-q", "main"]).unwrap();
        let before_delete = snapshot(&git).unwrap();
        git.output(["branch", "-D", "feature"]).unwrap();
        restore(&git, &before_delete, false).unwrap();
        assert_eq!(snapshot(&git).unwrap(), before_delete);
    }

    #[test]
    fn a_move_that_would_overwrite_uncommitted_work_is_refused() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        let before = snapshot(&git).unwrap();
        commit_file(&git, "a.txt", "a changed\n", "edit a");
        write(&git, "a.txt", "uncommitted edit\n");

        assert!(restore(&git, &before, false).is_err());
        assert_eq!(head(&git), snapshot(&git).unwrap().head.unwrap());
        assert_eq!(
            std::fs::read_to_string(git.root().join("a.txt")).unwrap(),
            "uncommitted edit\n",
            "nothing was thrown away"
        );
    }

    #[test]
    fn nothing_moves_while_a_merge_waits_for_the_user() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        git.output(["switch", "-q", "-c", "topic"]).unwrap();
        commit_file(&git, "a.txt", "topic\n", "topic edit");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "a.txt", "main\n", "main edit");
        let before = snapshot(&git).unwrap();
        let _ = git.output(["merge", "topic"]); // conflicts
        assert!(restore(&git, &before, false).is_err());
    }

    #[test]
    fn hostile_names_are_refused() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        let mut bad = snapshot(&git).unwrap();
        bad.branches.push(BranchTip {
            name: "--upload-pack=x".into(),
            oid: bad.head.clone().unwrap(),
        });
        assert!(restore(&git, &bad, false).is_err());
    }
}
