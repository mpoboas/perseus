//! Watches an open repository and reports *what kind* of change happened, debounced.
//!
//! The UI refreshes only what moved: `worktree` means files or the index changed (re-read
//! status), `refs` means branches, tags or HEAD moved (re-read refs and history). Everything
//! under `.git` that is not one of those (objects, logs, hooks, lock files) is ignored, as are
//! a few directories that change constantly and are almost never tracked.

use std::path::{Component, Path};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;

use crate::error::{AppError, Result};

/// What a batch of file-system events means for the UI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ChangeSet {
    pub refs: bool,
    pub worktree: bool,
}

impl ChangeSet {
    fn merge(&mut self, other: ChangeSet) {
        self.refs |= other.refs;
        self.worktree |= other.worktree;
    }

    fn is_empty(self) -> bool {
        !self.refs && !self.worktree
    }
}

/// Top-level directories skipped because builds and package managers rewrite them constantly.
const NOISY_DIRS: &[&str] = &["node_modules", "target", "__pycache__", ".gradle", ".venv"];

/// Classifies a path relative to the repository root. Pure, so it can be tested without a watcher.
pub fn classify(rel: &Path) -> ChangeSet {
    let mut parts = rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    });
    let Some(first) = parts.next() else {
        return ChangeSet::default();
    };
    let worktree = ChangeSet {
        worktree: true,
        refs: false,
    };

    if first != ".git" {
        return if NOISY_DIRS.contains(&first) {
            ChangeSet::default()
        } else {
            worktree
        };
    }

    let Some(inner) = parts.next() else {
        return ChangeSet::default();
    };
    let last = rel.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if last.ends_with(".lock") {
        return ChangeSet::default();
    }
    match inner {
        "HEAD" | "packed-refs" | "refs" | "ORIG_HEAD" => ChangeSet {
            refs: true,
            worktree: true,
        },
        "index" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD"
        | "MERGE_MSG" => worktree,
        // A rebase rewrites both the index and refs as it goes.
        "rebase-merge" | "rebase-apply" => ChangeSet {
            refs: true,
            worktree: true,
        },
        _ => ChangeSet::default(),
    }
}

/// A running watch. Dropping it stops the notifier and ends the debounce thread.
pub struct Watch {
    _watcher: RecommendedWatcher,
}

/// Starts watching `root` recursively. `on_change` runs on a background thread, at most once per
/// `quiet` period of silence.
pub fn watch(
    root: &Path,
    quiet: Duration,
    on_change: impl Fn(ChangeSet) + Send + 'static,
) -> Result<Watch> {
    let (tx, rx) = mpsc::channel::<ChangeSet>();
    // Some systems report events under the resolved path (macOS: `/private/var/...` for a folder
    // reached as `/var/...`, or through any symlink), so a path is matched against both spellings.
    let mut bases = vec![root.to_path_buf()];
    if let Ok(real) = root.canonicalize()
        && real != bases[0]
    {
        bases.push(real);
    }
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Pure reads (access events) never change anything.
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let mut set = ChangeSet::default();
        for path in &event.paths {
            if let Some(rel) = bases.iter().find_map(|b| path.strip_prefix(b).ok()) {
                set.merge(classify(rel));
            }
        }
        if !set.is_empty() {
            let _ = tx.send(set);
        }
    })
    .map_err(AppError::git)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(AppError::git)?;

    std::thread::spawn(move || {
        // The loop ends when the watcher (and with it the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            while let Ok(more) = rx.recv_timeout(quiet) {
                batch.merge(more);
            }
            on_change(batch);
        }
    });
    Ok(Watch { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn rel(s: &str) -> ChangeSet {
        classify(Path::new(s))
    }

    #[test]
    fn worktree_files_mean_status_changes() {
        assert_eq!(
            rel("src/main.rs"),
            ChangeSet {
                refs: false,
                worktree: true
            }
        );
        assert_eq!(
            rel("README.md"),
            ChangeSet {
                refs: false,
                worktree: true
            }
        );
    }

    #[test]
    fn refs_and_head_mean_history_changes() {
        for p in [
            ".git/HEAD",
            ".git/refs/heads/main",
            ".git/packed-refs",
            ".git/refs/tags/v1",
        ] {
            assert!(rel(p).refs, "{p}");
        }
        assert_eq!(
            rel(".git/index"),
            ChangeSet {
                refs: false,
                worktree: true
            }
        );
        assert_eq!(
            rel(".git/MERGE_HEAD"),
            ChangeSet {
                refs: false,
                worktree: true
            }
        );
        assert!(rel(".git/rebase-merge/done").refs);
    }

    #[test]
    fn git_internals_and_noise_are_ignored() {
        for p in [
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            ".git/hooks/pre-commit",
            ".git/index.lock",
            ".git/refs/heads/main.lock",
            ".git",
            "node_modules/x/y.js",
            "target/debug/app",
            "",
        ] {
            assert_eq!(rel(p), ChangeSet::default(), "{p:?}");
        }
    }

    /// Waits until `pred` holds for the collected change sets, or a timeout passes.
    fn wait_for(seen: &Arc<Mutex<Vec<ChangeSet>>>, pred: impl Fn(&[ChangeSet]) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if pred(&seen.lock().unwrap()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn reports_file_edits_and_ref_moves_from_a_real_repo() {
        let (dir, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let _watch = watch(dir.path(), Duration::from_millis(150), move |c| {
            sink.lock().unwrap().push(c)
        })
        .unwrap();

        write(&git, "a.txt", "edited\n");
        assert!(
            wait_for(&seen, |s| s.iter().any(|c| c.worktree)),
            "no worktree event"
        );

        seen.lock().unwrap().clear();
        git.output(["branch", "topic"]).unwrap();
        assert!(
            wait_for(&seen, |s| s.iter().any(|c| c.refs)),
            "no refs event after creating a branch"
        );
    }

    #[test]
    fn dropping_the_watch_stops_events() {
        let (dir, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let w = watch(dir.path(), Duration::from_millis(100), move |c| {
            sink.lock().unwrap().push(c)
        })
        .unwrap();
        drop(w);
        std::thread::sleep(Duration::from_millis(200));
        write(&git, "a.txt", "edited\n");
        std::thread::sleep(Duration::from_millis(600));
        assert!(seen.lock().unwrap().is_empty());
    }
}
