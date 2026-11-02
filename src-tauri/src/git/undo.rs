//! Undo and redo for local changes.
//!
//! The app takes a [`Snapshot`] before and after each action: which branch is checked out, where
//! every local branch and tag points, the stash list and, for actions that edit files (staging,
//! discarding, stashing), the trees of the index and of the tracked files on disk. Undoing puts all
//! of that back as it was. Only local state is touched: nothing that was pushed or fetched is ever
//! rewound, and uncommitted work is never thrown away (a move that would overwrite it is refused).
//! Untracked files cannot be brought back, since git never stored them.

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

/// One entry of the stash list: the stash commit and its reflog message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StashTip {
    pub oid: String,
    pub message: String,
}

/// The staged and on-disk state of the tracked files, as two trees.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileState {
    pub index: String,
    pub work: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    /// The checked-out branch, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// The commit HEAD points at (`None` before the first commit).
    pub head: Option<String>,
    /// Every local branch, sorted by name.
    pub branches: Vec<BranchTip>,
    /// Every tag, sorted by name.
    #[serde(default)]
    pub tags: Vec<BranchTip>,
    /// The stash list, newest first.
    #[serde(default)]
    pub stashes: Vec<StashTip>,
    /// Only taken for actions that edit files, because reading it means scanning the working tree.
    #[serde(default)]
    pub files: Option<FileState>,
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn tips(git: &Git, prefix: &str) -> Result<Vec<BranchTip>> {
    let listing = text(git.output([
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        prefix,
    ])?);
    let mut out: Vec<BranchTip> = listing
        .lines()
        .filter_map(|line| {
            let (name, oid) = line.split_once('\t')?;
            Some(BranchTip {
                name: name
                    .strip_prefix(prefix)?
                    .trim_start_matches('/')
                    .to_string(),
                oid: oid.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn stash_list(git: &Git) -> Result<Vec<StashTip>> {
    let listing =
        String::from_utf8_lossy(&git.output(["stash", "list", "--format=%H%x09%gs"])?).to_string();
    Ok(listing
        .lines()
        .filter_map(|line| {
            let (oid, message) = line.split_once('\t')?;
            Some(StashTip {
                oid: oid.to_string(),
                message: message.trim().to_string(),
            })
        })
        .collect())
}

/// The index and working tree as trees. Fails when they cannot be read (conflicts, no commit yet).
fn file_state(git: &Git) -> Result<FileState> {
    let step = |what: &str, e: AppError| AppError::Git(format!("{what}: {e}"));
    // A file rewritten with the same content looks changed until the index is refreshed, and
    // `stash create` then fails.
    git.output(["update-index", "-q", "--refresh"])
        .map_err(|e| step("update-index", e))?;
    let index = git
        .output(["write-tree"])
        .map_err(|e| step("write-tree", e))?;
    // `stash create` builds a commit of the working tree without touching any ref; it prints
    // nothing when there is nothing to stash, and then the files are exactly HEAD's.
    let made = text(
        git.clone()
            .with_env("GIT_LITERAL_PATHSPECS", "0")
            .output(["stash", "create"])
            .map_err(|e| step("stash create", e))?,
    );
    let base = if made.is_empty() {
        "HEAD".to_string()
    } else {
        made
    };
    let work = git
        .output(["rev-parse", "--verify", &format!("{base}^{{tree}}")])
        .map_err(|e| step("rev-parse", e))?;
    Ok(FileState {
        index: text(index),
        work: text(work),
    })
}

pub fn snapshot(git: &Git) -> Result<Snapshot> {
    capture(git, false)
}

/// Like [`snapshot`], plus the state of the files (slower on a big working tree).
pub fn snapshot_with_files(git: &Git) -> Result<Snapshot> {
    capture(git, true)
}

fn capture(git: &Git, with_files: bool) -> Result<Snapshot> {
    let branch = Some(text(
        git.output_allowing(["symbolic-ref", "-q", "--short", "HEAD"], &[0, 1])?,
    ))
    .filter(|b| !b.is_empty());
    let head = Some(text(
        git.output_allowing(["rev-parse", "-q", "--verify", "HEAD"], &[0, 1])?,
    ))
    .filter(|h| !h.is_empty());
    Ok(Snapshot {
        branch,
        head,
        branches: tips(git, "refs/heads")?,
        tags: tips(git, "refs/tags")?,
        stashes: stash_list(git)?,
        files: if with_files {
            file_state(git).ok()
        } else {
            None
        },
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
    for tip in target.branches.iter().chain(&target.tags) {
        validate::ref_name(&tip.name)?;
        validate::oid(&tip.oid)?;
    }
    for stash in &target.stashes {
        validate::oid(&stash.oid)?;
        if stash.message.contains('\0') {
            return Err(AppError::Git("A stash message contains a NUL byte".into()));
        }
    }
    if let Some(f) = &target.files {
        validate::oid(&f.index)?;
        validate::oid(&f.work)?;
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
    restore_from(git, target, keep_changes, None)
}

/// [`restore`], told which state is being left. That lets edits to files be undone only while the
/// files are still as the action left them.
pub fn restore_from(
    git: &Git,
    target: &Snapshot,
    keep_changes: bool,
    from: Option<&Snapshot>,
) -> Result<()> {
    check(target)?;
    if let Some(f) = from {
        check(f)?;
    }
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

    restore_tags(git, &target.tags)?;
    restore_stashes_and_files(git, target, from)
}

fn restore_tags(git: &Git, wanted: &[BranchTip]) -> Result<()> {
    let now = tips(git, "refs/tags")?;
    for tag in wanted {
        let old = now
            .iter()
            .find(|t| t.name == tag.name)
            .map(|t| t.oid.as_str());
        if old != Some(tag.oid.as_str()) {
            git.output([
                "update-ref",
                "-m",
                "perseus: undo",
                &format!("refs/tags/{}", tag.name),
                &tag.oid,
                old.unwrap_or(ZERO),
            ])?;
        }
    }
    for tag in &now {
        if !wanted.iter().any(|t| t.name == tag.name) {
            git.output([
                "update-ref",
                "-d",
                &format!("refs/tags/{}", tag.name),
                &tag.oid,
            ])?;
        }
    }
    Ok(())
}

fn restore_stashes_and_files(git: &Git, target: &Snapshot, from: Option<&Snapshot>) -> Result<()> {
    let now = stash_list(git)?;
    // Stash commands run their own pathspec commands internally, which literal-pathspec mode
    // (our default) makes match nothing; none of these take a pathspec from anyone.
    let loose = git.clone().with_env("GIT_LITERAL_PATHSPECS", "0");
    let extra = now.len().saturating_sub(target.stashes.len());
    // Stashes were pushed on top: taking them back off also gives the changes back.
    if extra > 0 && now[extra..] == target.stashes[..] {
        for _ in 0..extra {
            loose.output(["stash", "pop", "--index"])?;
        }
        return Ok(());
    }
    if let Some(files) = &target.files {
        restore_files(git, files, from)?;
    }
    if now != target.stashes {
        // A stash that is coming back may have put untracked files on disk when it was popped.
        for tip in target
            .stashes
            .iter()
            .filter(|t| !now.iter().any(|n| n.oid == t.oid))
        {
            remove_stash_untracked(git, &tip.oid)?;
        }
        // A dropped or popped stash comes back from its commit, which is still in the repository.
        loose.output(["stash", "clear"])?;
        for stash in target.stashes.iter().rev() {
            loose.output(["stash", "store", "-m", &stash.message, &stash.oid])?;
        }
    }
    Ok(())
}

/// Deletes the untracked files that popping `stash` put on disk, but only those still exactly as the
/// stash had them and not tracked since: anything edited or committed afterwards is left alone.
fn remove_stash_untracked(git: &Git, stash: &str) -> Result<()> {
    // The third parent of a stash commit holds the untracked files, when it was made with `-u`.
    let listing = git.output_allowing(["ls-tree", "-r", "-z", &format!("{stash}^3")], &[0, 128])?;
    for entry in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let Some((meta, path)) = entry.split_once('\t') else {
            continue;
        };
        let Some(blob) = meta.split_whitespace().nth(2) else {
            continue;
        };
        if validate::rel_path(path).is_err() || !git.root().join(path).is_file() {
            continue;
        }
        let tracked = !text(git.output(["ls-files", "--", path])?).is_empty();
        let same = text(git.output(["hash-object", "--", path])?) == blob;
        if !tracked && same {
            let _ = std::fs::remove_file(git.root().join(path));
        }
    }
    Ok(())
}

fn restore_files(git: &Git, target: &FileState, from: Option<&Snapshot>) -> Result<()> {
    let now = file_state(git).map_err(|e| {
        AppError::Git(format!(
            "The files cannot be read right now ({e}), so nothing was undone"
        ))
    })?;
    if now == *target {
        return Ok(());
    }
    if now.work != target.work {
        // The action changed the files on disk. Going back is only safe while nobody has touched
        // them since: otherwise it would overwrite that newer work.
        let left = from.and_then(|f| f.files.as_ref());
        if left.is_none_or(|l| l.work != now.work) {
            return Err(AppError::Git(
                "Some files have changed since, and going back would overwrite those edits. Nothing was undone"
                    .into(),
            ));
        }
        // Files the action created are not in the old tree, and `restore` only writes files.
        let created = git.output([
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--diff-filter=A",
            &target.work,
            &now.work,
        ])?;
        for path in created.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let path = String::from_utf8_lossy(path).to_string();
            if validate::rel_path(&path).is_ok() {
                // Already gone is as good as removed.
                let _ = std::fs::remove_file(git.root().join(&path));
            }
        }
        git.output(["restore", "--source", &target.work, "--worktree", "--", "."])?;
    }
    // Only the index: the files on disk are left exactly as they are.
    git.output(["read-tree", &target.index])?;
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
    fn a_clean_repository_has_a_file_state_too() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        let state = file_state(&git).unwrap();
        assert_eq!(
            state.index, state.work,
            "nothing changed, so both are HEAD's tree"
        );
    }

    fn read(git: &Git, rel: &str) -> String {
        std::fs::read_to_string(git.root().join(rel)).unwrap()
    }

    #[test]
    fn creating_and_deleting_tags_is_undone_and_redone() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        git.output(["tag", "keep"]).unwrap();
        let start = snapshot(&git).unwrap();

        git.output(["tag", "-a", "v1", "-m", "release"]).unwrap();
        let tagged = snapshot(&git).unwrap();
        assert_eq!(tagged.tags.len(), 2);
        restore(&git, &start, false).unwrap();
        assert_eq!(snapshot(&git).unwrap(), start, "the new tag is gone");
        restore(&git, &tagged, false).unwrap();
        assert_eq!(
            snapshot(&git).unwrap(),
            tagged,
            "and back, annotation included"
        );

        git.output(["tag", "-d", "keep"]).unwrap();
        restore(&git, &tagged, false).unwrap();
        assert_eq!(snapshot(&git).unwrap(), tagged, "a deleted tag returns");

        // A tag moved to another commit goes back to the first.
        commit_file(&git, "b.txt", "b\n", "second");
        git.output(["tag", "-f", "keep"]).unwrap();
        let moved = snapshot(&git).unwrap();
        assert_ne!(moved.tags, tagged.tags);
        let mut only_tags = moved.clone();
        only_tags.tags = tagged.tags.clone();
        restore(&git, &only_tags, false).unwrap();
        assert_eq!(snapshot(&git).unwrap().tags, tagged.tags);
    }

    #[test]
    fn staging_and_unstaging_are_undone_without_touching_the_files() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        write(&git, "a.txt", "edited\n");
        let before = snapshot_with_files(&git).unwrap();
        git.output(["add", "a.txt"]).unwrap();
        let after = snapshot_with_files(&git).unwrap();
        assert_ne!(before.files, after.files);

        restore_from(&git, &before, false, Some(&after)).unwrap();
        assert_eq!(
            text(git.output(["status", "--porcelain"]).unwrap()),
            "M a.txt"
        );
        assert_eq!(read(&git, "a.txt"), "edited\n", "the edit itself stays");

        restore_from(&git, &after, false, Some(&before)).unwrap();
        assert_eq!(
            text(git.output(["status", "--porcelain"]).unwrap()),
            "M  a.txt"
        );
    }

    #[test]
    fn a_discard_comes_back_unless_the_file_changed_again() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        commit_file(&git, "b.txt", "b\n", "base b");
        write(&git, "a.txt", "precious edit\n");
        git.output(["add", "a.txt"]).unwrap();
        write(&git, "b.txt", "other edit\n");
        let before = snapshot_with_files(&git).unwrap();

        git.output(["checkout", "HEAD", "--", "a.txt", "b.txt"])
            .unwrap();
        let after = snapshot_with_files(&git).unwrap();
        assert_eq!(read(&git, "a.txt"), "a\n");

        // Someone edits again: undoing would clobber that, so it is refused and nothing moves.
        write(&git, "a.txt", "newer work\n");
        assert!(restore_from(&git, &before, false, Some(&after)).is_err());
        assert_eq!(read(&git, "a.txt"), "newer work\n");
        write(&git, "a.txt", "a\n");

        restore_from(&git, &before, false, Some(&after)).unwrap();
        assert_eq!(read(&git, "a.txt"), "precious edit\n");
        assert_eq!(read(&git, "b.txt"), "other edit\n");
        assert_eq!(
            text(git.output(["status", "--porcelain"]).unwrap()),
            "M  a.txt\n M b.txt",
            "the staged and unstaged parts are as they were"
        );

        // And the discard can be redone.
        restore_from(&git, &after, false, Some(&before)).unwrap();
        assert_eq!(read(&git, "a.txt"), "a\n");
        assert_eq!(text(git.output(["status", "--porcelain"]).unwrap()), "");
    }

    #[test]
    fn stashing_is_undone_by_taking_the_stash_back_off() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        write(&git, "a.txt", "work in progress\n");
        write(&git, "new.txt", "brand new\n");
        git.output(["add", "new.txt"]).unwrap();
        let before = snapshot_with_files(&git).unwrap();

        git.output(["stash", "push", "-m", "wip"]).unwrap();
        let after = snapshot_with_files(&git).unwrap();
        assert_eq!(after.stashes.len(), 1);
        assert_eq!(read(&git, "a.txt"), "a\n");

        restore_from(&git, &before, false, Some(&after)).unwrap();
        assert!(snapshot(&git).unwrap().stashes.is_empty());
        assert_eq!(read(&git, "a.txt"), "work in progress\n");
        assert_eq!(
            text(git.output(["status", "--porcelain"]).unwrap()),
            // (the leading blank of " M" is trimmed by `text`)
            "M a.txt\nA  new.txt",
            "staged and unstaged state both return"
        );
    }

    #[test]
    fn popping_a_stash_is_undone_and_the_stash_returns() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        write(&git, "a.txt", "stashed edit\n");
        write(&git, "new.txt", "from the stash\n");
        git.output(["add", "new.txt"]).unwrap();
        git.output(["stash", "push", "-m", "keep me"]).unwrap();
        let before = snapshot_with_files(&git).unwrap();
        assert_eq!(before.stashes.len(), 1);

        git.output(["stash", "pop", "--index"]).unwrap();
        let after = snapshot_with_files(&git).unwrap();
        assert!(after.stashes.is_empty());
        assert!(git.root().join("new.txt").exists());

        restore_from(&git, &before, false, Some(&after)).unwrap();
        assert_eq!(read(&git, "a.txt"), "a\n");
        assert!(
            !git.root().join("new.txt").exists(),
            "a file the pop created is removed again"
        );
        let back = snapshot(&git).unwrap().stashes;
        assert_eq!(back, before.stashes, "the same stash commit, same message");
        // Dropping is undone the same way.
        git.output(["stash", "drop"]).unwrap();
        restore_from(&git, &before, false, None).unwrap();
        assert_eq!(snapshot(&git).unwrap().stashes, before.stashes);
    }

    #[test]
    fn undoing_a_pop_takes_back_untracked_files_that_are_still_as_stashed() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        write(&git, "scratch.txt", "untracked\n");
        write(&git, "edited-later.txt", "from stash\n");
        git.clone()
            .with_env("GIT_LITERAL_PATHSPECS", "0")
            .output(["stash", "push", "-u", "-m", "with untracked"])
            .unwrap();
        let before = snapshot_with_files(&git).unwrap();
        assert!(!git.root().join("scratch.txt").exists());

        git.clone()
            .with_env("GIT_LITERAL_PATHSPECS", "0")
            .output(["stash", "pop"])
            .unwrap();
        let after = snapshot_with_files(&git).unwrap();
        write(&git, "edited-later.txt", "my own change\n");

        restore_from(&git, &before, false, Some(&after)).unwrap();
        assert!(
            !git.root().join("scratch.txt").exists(),
            "unchanged: removed"
        );
        assert_eq!(
            read(&git, "edited-later.txt"),
            "my own change\n",
            "edited: kept"
        );
        assert_eq!(snapshot(&git).unwrap().stashes, before.stashes);
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
