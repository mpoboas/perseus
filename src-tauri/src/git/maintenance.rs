//! Repository upkeep: size statistics, garbage collection, the commit-graph file, an integrity
//! check and forgetting remote branches that no longer exist.
//!
//! Nothing here deletes anything git would still need. `gc` only removes unreachable objects older
//! than git's own grace period (two weeks), and there is deliberately no "prune now".

use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::git::cli::Git;
use crate::git::validate;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Task {
    /// `git gc`: pack loose objects, drop what is unreachable and old, pack the refs.
    Gc,
    /// `git gc --aggressive`: the same with a much slower, deeper repack.
    GcAggressive,
    /// Writes the commit-graph file, which makes history walks and path searches faster.
    CommitGraph,
    /// `git fsck`: checks that every object is intact and reachable objects are all present.
    Fsck,
    /// Forgets remote-tracking branches whose branch is gone from the remote.
    PruneRemotes,
}

/// What `git count-objects -v` reports, plus the state of the commit-graph file.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct RepoStats {
    pub loose_objects: u64,
    pub loose_kib: u64,
    pub packed_objects: u64,
    pub packs: u64,
    pub pack_kib: u64,
    /// Objects that are both loose and packed, which `gc` removes.
    pub prune_packable: u64,
    pub garbage_files: u64,
    pub garbage_kib: u64,
    pub commit_graph: bool,
    /// Git's own threshold for running `gc --auto` has been passed.
    pub gc_advised: bool,
}

/// Loose objects at which `git gc --auto` starts (its default for `gc.auto`).
const GC_AUTO_LOOSE: u64 = 6700;
/// Packs at which `git gc --auto` starts (its default for `gc.autoPackLimit`).
const GC_AUTO_PACKS: u64 = 50;

pub fn parse_stats(text: &str) -> RepoStats {
    let mut s = RepoStats::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Ok(n) = value.trim().parse::<u64>() else {
            continue;
        };
        match key.trim() {
            "count" => s.loose_objects = n,
            "size" => s.loose_kib = n,
            "in-pack" => s.packed_objects = n,
            "packs" => s.packs = n,
            "size-pack" => s.pack_kib = n,
            "prune-packable" => s.prune_packable = n,
            "garbage" => s.garbage_files = n,
            "size-garbage" => s.garbage_kib = n,
            _ => {}
        }
    }
    s.gc_advised = s.loose_objects >= GC_AUTO_LOOSE || s.packs >= GC_AUTO_PACKS;
    s
}

pub fn stats(git: &Git) -> Result<RepoStats> {
    let out = git.output(["count-objects", "-v"])?;
    let mut s = parse_stats(&String::from_utf8_lossy(&out));
    // `--git-path` answers relative to the working tree and follows worktrees and `GIT_DIR`.
    let graph = |what: &str| -> bool {
        git.output(["rev-parse", "--git-path", what])
            .ok()
            .map(|p| String::from_utf8_lossy(&p).trim().to_string())
            .is_some_and(|p| git.root().join(p).exists())
    };
    s.commit_graph = graph("objects/info/commit-graph") || graph("objects/info/commit-graphs");
    Ok(s)
}

/// Runs one task. Progress and git's messages go to `on_line`; the return value is its output.
pub fn run(
    git: &Git,
    task: Task,
    mut on_line: impl FnMut(&str),
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    match task {
        Task::Gc => git.stream_cancellable(["gc"], on_line, cancel),
        Task::GcAggressive => git.stream_cancellable(["gc", "--aggressive"], on_line, cancel),
        Task::CommitGraph => git.stream_cancellable(
            ["commit-graph", "write", "--reachable", "--changed-paths"],
            on_line,
            cancel,
        ),
        // Dangling objects are normal (dropped stashes, old amends); only real damage matters.
        Task::Fsck => {
            git.stream_cancellable(["fsck", "--no-progress", "--no-dangling"], on_line, cancel)
        }
        Task::PruneRemotes => {
            let listed = git.output(["remote"])?;
            let names: Vec<String> = String::from_utf8_lossy(&listed)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if names.is_empty() {
                on_line("This repository has no remotes.");
                return Ok(Vec::new());
            }
            let mut all = Vec::new();
            for name in &names {
                validate::remote_name(name)?;
                all.extend(git.stream_cancellable(
                    ["remote", "prune", name.as_str()],
                    &mut on_line,
                    cancel,
                )?);
            }
            Ok(all)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn quiet(_: &str) {}

    fn history(git: &Git, commits: usize) {
        for i in 0..commits {
            commit_file(
                git,
                &format!("f{i}.txt"),
                &format!("content {i}\n"),
                &format!("commit {i}"),
            );
        }
    }

    #[test]
    fn count_objects_output_is_parsed() {
        let s = parse_stats(
            "count: 12\nsize: 48\nin-pack: 300\npacks: 2\nsize-pack: 640\nprune-packable: 3\ngarbage: 1\nsize-garbage: 2\n",
        );
        assert_eq!((s.loose_objects, s.loose_kib), (12, 48));
        assert_eq!((s.packed_objects, s.packs, s.pack_kib), (300, 2, 640));
        assert_eq!(s.prune_packable, 3);
        assert_eq!((s.garbage_files, s.garbage_kib), (1, 2));
        assert!(!s.gc_advised);
        assert!(parse_stats("count: 7000\n").gc_advised);
        assert!(parse_stats("packs: 50\n").gc_advised);
        assert_eq!(parse_stats("nonsense"), RepoStats::default());
    }

    #[test]
    fn gc_packs_loose_objects_and_the_stats_show_it() {
        let (_d, git) = init_repo();
        history(&git, 5);
        let before = stats(&git).unwrap();
        assert!(before.loose_objects > 0);
        assert_eq!(before.packs, 0);

        run(&git, Task::Gc, quiet, &AtomicBool::new(false)).unwrap();

        let after = stats(&git).unwrap();
        assert_eq!(after.loose_objects, 0);
        assert_eq!(after.packs, 1);
        assert!(after.packed_objects >= before.loose_objects);
        // History is intact.
        let log = git.output(["log", "--format=%s"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&log).lines().count(), 5);
    }

    #[test]
    fn the_aggressive_variant_also_works() {
        let (_d, git) = init_repo();
        history(&git, 3);
        run(&git, Task::GcAggressive, quiet, &AtomicBool::new(false)).unwrap();
        assert_eq!(stats(&git).unwrap().loose_objects, 0);
    }

    #[test]
    fn gc_keeps_a_dropped_stash_that_is_still_inside_the_grace_period() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "first");
        write(&git, "a.txt", "two\n");
        git.output(["stash", "push", "-q", "-m", "work"]).unwrap();
        let tip = String::from_utf8_lossy(&git.output(["rev-parse", "stash@{0}"]).unwrap())
            .trim()
            .to_string();
        git.output(["stash", "drop", "-q"]).unwrap();

        run(&git, Task::Gc, quiet, &AtomicBool::new(false)).unwrap();

        // Undo of "drop stash" depends on this commit surviving.
        git.output(["cat-file", "-e", tip.as_str()]).unwrap();
    }

    #[test]
    fn the_commit_graph_file_is_written() {
        let (_d, git) = init_repo();
        history(&git, 3);
        assert!(!stats(&git).unwrap().commit_graph);
        run(&git, Task::CommitGraph, quiet, &AtomicBool::new(false)).unwrap();
        assert!(stats(&git).unwrap().commit_graph);
    }

    // Git writes objects read-only, and on Windows that must be cleared before damaging one.
    #[allow(clippy::permissions_set_readonly_false)]
    #[test]
    fn fsck_passes_on_a_healthy_repository_and_reports_damage() {
        let (dir, git) = init_repo();
        history(&git, 2);
        run(&git, Task::Fsck, quiet, &AtomicBool::new(false)).unwrap();

        // Damage the newest commit object itself.
        let head = String::from_utf8_lossy(&git.output(["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string();
        let object = dir
            .path()
            .join(".git/objects")
            .join(&head[..2])
            .join(&head[2..]);
        let mut perms = std::fs::metadata(&object).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&object, perms).unwrap();
        std::fs::write(&object, b"this is not a git object").unwrap();

        let mut lines = Vec::new();
        let result = run(
            &git,
            Task::Fsck,
            |l| lines.push(l.to_string()),
            &AtomicBool::new(false),
        );
        assert!(result.is_err(), "damage must not look like success");
    }

    #[test]
    fn stale_remote_branches_are_forgotten() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "first");
        let remote = tempfile::tempdir().unwrap();
        let bare = Git::new(remote.path());
        bare.output(["init", "-q", "--bare", "-b", "main"]).unwrap();
        let url = remote.path().to_string_lossy().into_owned();
        git.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        git.output(["branch", "topic"]).unwrap();
        git.output(["push", "-q", "origin", "main", "topic"])
            .unwrap();
        git.output(["fetch", "-q", "origin"]).unwrap();
        assert!(git.output(["rev-parse", "origin/topic"]).is_ok());

        bare.output(["branch", "-q", "-D", "topic"]).unwrap();
        let out = run(&git, Task::PruneRemotes, quiet, &AtomicBool::new(false)).unwrap();

        assert!(String::from_utf8_lossy(&out).contains("origin/topic"));
        assert!(
            git.output(["rev-parse", "--verify", "-q", "origin/topic"])
                .is_err()
        );
        assert!(
            git.output(["rev-parse", "origin/main"]).is_ok(),
            "live branches stay"
        );
    }

    #[test]
    fn pruning_without_remotes_says_so() {
        let (_d, git) = init_repo();
        let mut lines = Vec::new();
        run(
            &git,
            Task::PruneRemotes,
            |l| lines.push(l.to_string()),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(lines, ["This repository has no remotes."]);
    }
}
