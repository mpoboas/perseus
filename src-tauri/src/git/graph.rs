use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use gix::ObjectId;
use gix::traverse::commit::topo::{Builder, Sorting};
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::lanes::{LaneAllocator, LaneRow};

pub const DEFAULT_CHUNK_SIZE: usize = 500;

/// Whether the repository already has a commit-graph file (single file or split chain).
fn has_commit_graph(git: &Git) -> bool {
    [
        "objects/info/commit-graph",
        "objects/info/commit-graphs/commit-graph-chain",
    ]
    .iter()
    .any(|p| {
        git.output(["rev-parse", "--git-path", p])
            .ok()
            .map(|o| std::path::PathBuf::from(String::from_utf8_lossy(&o).trim()))
            .is_some_and(|path| git.root().join(path).exists())
    })
}

/// Makes sure a commit-graph file exists. Without one, reading history means opening every
/// commit object (about 7,000 commits per second here); with one it is about 125,000 per second,
/// so a 500,000-commit repository goes from over a minute to a few seconds. The file is a pure
/// cache that git itself writes during `gc` and `maintenance`, so creating it is safe. Failures
/// (read-only repository, shallow clone) are ignored: the walk still works, just slower.
pub fn ensure_commit_graph(git: &Git) {
    if !has_commit_graph(git) {
        let _ = git.output(["commit-graph", "write", "--reachable"]);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitRow {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Committer time, seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
    /// Short ref names (`main`, `origin/main`, `v1.0`) pointing at this commit.
    pub refs: Vec<String>,
    /// Lane geometry for drawing this row of the graph.
    pub graph: LaneRow,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct WalkSummary {
    pub total: usize,
    pub cancelled: bool,
}

type RefsByCommit = HashMap<ObjectId, Vec<String>>;

/// Collects every ref (plus HEAD) that peels to a commit, grouped by commit id.
fn collect_tips(repo: &gix::Repository) -> Result<(Vec<ObjectId>, RefsByCommit)> {
    let mut by_id: HashMap<ObjectId, Vec<String>> = HashMap::new();

    if let Ok(head) = repo.head_id() {
        by_id.entry(head.detach()).or_default().push("HEAD".into());
    }

    let platform = repo.references().map_err(AppError::git)?;
    for reference in platform.all().map_err(AppError::git)? {
        let mut reference = reference.map_err(AppError::git)?;
        let name = reference.name().shorten().to_string();
        // Skip refs that do not end at a commit (e.g. tags of trees/blobs) and broken refs.
        let Ok(id) = reference.peel_to_id() else {
            continue;
        };
        let id = id.detach();
        match repo.find_object(id) {
            Ok(obj) if obj.kind.is_commit() => by_id.entry(id).or_default().push(name),
            _ => {}
        }
    }

    let mut tips: Vec<ObjectId> = by_id.keys().copied().collect();
    tips.sort(); // deterministic walk order independent of HashMap iteration
    Ok((tips, by_id))
}

fn read_row(
    repo: &gix::Repository,
    id: ObjectId,
    parents: &[ObjectId],
    refs: Option<&Vec<String>>,
    graph: LaneRow,
) -> Result<CommitRow> {
    let commit = repo.find_commit(id).map_err(AppError::git)?;
    let author = commit.author().map_err(AppError::git)?;
    let committer = commit.committer().map_err(AppError::git)?;
    let message = commit.message().map_err(AppError::git)?;
    Ok(CommitRow {
        oid: id.to_string(),
        parents: parents.iter().map(|p| p.to_string()).collect(),
        author: author.name.to_string(),
        time: committer.time().map(|t| t.seconds).unwrap_or_default(),
        summary: message.summary().to_string(),
        refs: refs.cloned().unwrap_or_default(),
        graph,
    })
}

/// Walks all history in `git log --topo-order --all` order, calling `emit` with
/// batches of up to `chunk_size` rows. `emit` returns `false` to stop early (e.g.
/// the webview went away). The walk also stops when `cancel` is set.
///
/// Uses the on-disk commit-graph file when present, which lets gix short-circuit
/// using generation numbers.
pub fn walk_commits(
    repo: &gix::Repository,
    chunk_size: usize,
    cancel: &AtomicBool,
    mut emit: impl FnMut(Vec<CommitRow>) -> bool,
) -> Result<WalkSummary> {
    let chunk_size = chunk_size.max(1);
    let (tips, refs) = collect_tips(repo)?;
    if tips.is_empty() {
        return Ok(WalkSummary {
            total: 0,
            cancelled: false,
        });
    }

    let graph = repo.commit_graph_if_enabled().map_err(AppError::git)?;
    let walk = Builder::from_iters(repo.objects.clone(), tips, None::<Vec<ObjectId>>)
        .sorting(Sorting::TopoOrder)
        .with_commit_graph(graph)
        .build()
        .map_err(AppError::git)?;

    let mut lanes = LaneAllocator::new();
    let mut batch = Vec::with_capacity(chunk_size);
    let mut total = 0;
    for info in walk {
        if cancel.load(Ordering::Relaxed) {
            return Ok(WalkSummary {
                total,
                cancelled: true,
            });
        }
        let info = info.map_err(AppError::git)?;
        let graph = lanes.push(info.id, &info.parent_ids);
        batch.push(read_row(
            repo,
            info.id,
            &info.parent_ids,
            refs.get(&info.id),
            graph,
        )?);
        total += 1;
        if batch.len() == chunk_size {
            let full = std::mem::replace(&mut batch, Vec::with_capacity(chunk_size));
            if !emit(full) {
                return Ok(WalkSummary {
                    total,
                    cancelled: true,
                });
            }
        }
    }
    if !batch.is_empty() && !emit(batch) {
        return Ok(WalkSummary {
            total,
            cancelled: true,
        });
    }
    Ok(WalkSummary {
        total,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// main: A-B-D(merge)-E, feature: C (branched from A, merged at D).
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["commit", "-q", "--allow-empty", "-m", "A"]);
        git(p, &["checkout", "-q", "-b", "feature"]);
        git(p, &["commit", "-q", "--allow-empty", "-m", "C"]);
        git(p, &["checkout", "-q", "main"]);
        git(p, &["commit", "-q", "--allow-empty", "-m", "B"]);
        git(p, &["merge", "-q", "--no-ff", "feature", "-m", "D"]);
        git(p, &["commit", "-q", "--allow-empty", "-m", "E"]);
        git(p, &["tag", "v1"]);
        dir
    }

    fn collect(repo: &gix::Repository, chunk: usize) -> (Vec<Vec<CommitRow>>, WalkSummary) {
        let mut chunks = Vec::new();
        let cancel = AtomicBool::new(false);
        let summary = walk_commits(repo, chunk, &cancel, |c| {
            chunks.push(c);
            true
        })
        .unwrap();
        (chunks, summary)
    }

    #[test]
    fn children_precede_parents_and_chunks_are_bounded() {
        let dir = fixture();
        let repo = gix::open(dir.path()).unwrap();
        let (chunks, summary) = collect(&repo, 2);

        assert_eq!(
            summary,
            WalkSummary {
                total: 5,
                cancelled: false
            }
        );
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [2, 2, 1]);

        let rows: Vec<_> = chunks.into_iter().flatten().collect();
        let pos: HashMap<_, _> = rows
            .iter()
            .enumerate()
            .map(|(i, r)| (r.oid.clone(), i))
            .collect();
        for (i, row) in rows.iter().enumerate() {
            for parent in &row.parents {
                assert!(
                    pos[parent] > i,
                    "parent {parent} of {} listed before child",
                    row.summary
                );
            }
        }
        assert_eq!(rows[0].summary, "E");
        assert_eq!(rows.last().unwrap().summary, "A");
    }

    #[test]
    fn includes_refs_and_all_branches() {
        let dir = fixture();
        let repo = gix::open(dir.path()).unwrap();
        let (chunks, _) = collect(&repo, 500);
        let rows: Vec<_> = chunks.into_iter().flatten().collect();

        let e = rows.iter().find(|r| r.summary == "E").unwrap();
        for name in ["HEAD", "main", "v1"] {
            assert!(
                e.refs.iter().any(|r| r == name),
                "{name} missing from {:?}",
                e.refs
            );
        }
        let c = rows.iter().find(|r| r.summary == "C").unwrap();
        assert!(c.refs.iter().any(|r| r == "feature"));
        assert_eq!(
            rows.iter()
                .find(|r| r.summary == "D")
                .unwrap()
                .parents
                .len(),
            2
        );
    }

    #[test]
    fn cancel_flag_stops_the_walk() {
        let dir = fixture();
        let repo = gix::open(dir.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let mut seen = 0;
        let summary = walk_commits(&repo, 1, &cancel, |c| {
            seen += c.len();
            cancel.store(true, Ordering::Relaxed);
            true
        })
        .unwrap();
        assert!(summary.cancelled);
        assert_eq!(seen, 1);
    }

    /// Manual perf check: `cargo test --release -- --ignored --nocapture large_history`.
    /// Builds a 100k-commit repo with `git fast-import` and times the walk.
    #[test]
    #[ignore]
    fn large_history_streams_quickly() {
        use std::io::Write;
        use std::process::Stdio;

        const N: usize = 100_000;
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let mut child = Command::new("git")
            .args(["fast-import", "--quiet"])
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut w = std::io::BufWriter::new(child.stdin.take().unwrap());
            for i in 1..=N {
                let msg = format!("commit {i}");
                write!(
                    w,
                    "commit refs/heads/main\nmark :{i}\ncommitter T <t@t> {} +0000\ndata {}\n{msg}\n",
                    1_600_000_000 + i,
                    msg.len()
                )
                .unwrap();
                if i > 1 {
                    writeln!(w, "from :{}", i - 1).unwrap();
                }
                writeln!(w).unwrap();
            }
        }
        assert!(child.wait().unwrap().success());

        let repo = gix::open(dir.path()).unwrap();
        let started = std::time::Instant::now();
        let (chunks, summary) = collect(&repo, DEFAULT_CHUNK_SIZE);
        eprintln!(
            "walked {} commits in {} chunks in {:?}",
            summary.total,
            chunks.len(),
            started.elapsed()
        );
        assert_eq!(summary.total, N);
    }

    #[test]
    fn empty_repo_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let repo = gix::open(dir.path()).unwrap();
        let (chunks, summary) = collect(&repo, 10);
        assert!(chunks.is_empty());
        assert_eq!(summary.total, 0);
    }

    #[test]
    fn writes_a_commit_graph_only_when_missing() {
        use crate::git::cli::testutil::*;
        let (dir, git) = init_repo();
        commit_file(
            &git, "a.txt", "a
", "a",
        );
        commit_file(
            &git, "b.txt", "b
", "b",
        );
        let graph = dir.path().join(".git/objects/info/commit-graph");
        assert!(!graph.exists());
        ensure_commit_graph(&git);
        assert!(graph.exists(), "commit-graph should have been written");
        let stamp = std::fs::metadata(&graph).unwrap().modified().unwrap();
        ensure_commit_graph(&git);
        assert_eq!(
            std::fs::metadata(&graph).unwrap().modified().unwrap(),
            stamp
        );

        // The walk gives the same rows with or without the file.
        let repo = gix::open(dir.path()).unwrap();
        let mut n = 0;
        walk_commits(&repo, 10, &AtomicBool::new(false), |rows| {
            n += rows.len();
            true
        })
        .unwrap();
        assert_eq!(n, 2);
    }

    // ---- Snapshot tests: the lane layout of small, well-known history shapes ----

    use crate::git::cli::GitOverrides;
    use crate::git::cli::testutil::*;

    /// A repo whose commits get strictly increasing, fixed timestamps, so topological order
    /// (and therefore the snapshot) is the same on every run and machine.
    struct Fixture {
        _dir: tempfile::TempDir,
        git: Git,
        tick: i64,
    }

    impl Fixture {
        fn new() -> Self {
            let (dir, git) = init_repo();
            Self {
                _dir: dir,
                git,
                tick: 1_700_000_000,
            }
        }

        fn at(&mut self) -> Git {
            self.tick += 60;
            let date = format!("{} +0000", self.tick);
            self.git.clone().with_overrides(GitOverrides {
                config: vec![],
                env: vec![
                    ("GIT_AUTHOR_DATE".into(), date.clone()),
                    ("GIT_COMMITTER_DATE".into(), date),
                ],
            })
        }

        fn commit(&mut self, name: &str) {
            write(&self.git, &format!("{name}.txt"), name);
            self.git.output(["add", "-A"]).unwrap();
            self.at().output(["commit", "-q", "-m", name]).unwrap();
        }

        fn branch(&mut self, name: &str) {
            self.git.output(["switch", "-q", "-c", name]).unwrap();
        }

        fn switch(&mut self, name: &str) {
            self.git.output(["switch", "-q", name]).unwrap();
        }

        fn merge(&mut self, branches: &[&str], message: &str) {
            let mut args = vec!["merge", "--no-ff", "-q", "-m", message];
            args.extend_from_slice(branches);
            self.at().output(args).unwrap();
        }

        /// One line per row: `summary  lane  in/through/out`, lanes only (colors are cosmetic).
        fn snapshot(&self) -> String {
            let repo = gix::open(self.git.root()).unwrap();
            let mut rows = Vec::new();
            walk_commits(&repo, 100, &AtomicBool::new(false), |chunk| {
                rows.extend(chunk);
                true
            })
            .unwrap();
            let lanes = |v: &[(u16, u16)]| {
                v.iter()
                    .map(|(l, _)| l.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            };
            rows.iter()
                .map(|r| {
                    format!(
                        "{:<8} lane {} in [{}] through [{}] out [{}]",
                        r.summary,
                        r.graph.lane,
                        lanes(&r.graph.incoming),
                        lanes(&r.graph.through),
                        lanes(&r.graph.outgoing)
                    )
                })
                .collect::<Vec<_>>()
                .join(
                    "
",
                )
        }
    }

    #[test]
    fn snapshot_linear() {
        let mut f = Fixture::new();
        for c in ["a", "b", "c"] {
            f.commit(c);
        }
        assert_snapshot(
            &f.snapshot(),
            "c        lane 0 in [] through [] out [0]
b        lane 0 in [0] through [] out [0]
a        lane 0 in [0] through [] out []",
        );
    }

    #[test]
    fn snapshot_merge() {
        let mut f = Fixture::new();
        f.commit("a");
        f.branch("topic");
        f.commit("t1");
        f.switch("main");
        f.commit("b");
        f.merge(&["topic"], "m");
        assert_snapshot(
            &f.snapshot(),
            "m        lane 0 in [] through [] out [0,1]
t1       lane 1 in [1] through [0] out [1]
b        lane 0 in [0] through [1] out [1]
a        lane 1 in [1] through [] out []",
        );
    }

    #[test]
    fn snapshot_octopus() {
        let mut f = Fixture::new();
        f.commit("a");
        for b in ["b1", "b2", "b3"] {
            f.switch("main");
            f.branch(b);
            f.commit(b);
        }
        f.switch("main");
        f.merge(&["b1", "b2", "b3"], "octo");
        assert_snapshot(
            &f.snapshot(),
            "octo     lane 0 in [] through [] out [0,1,2,3]
b3       lane 3 in [3] through [0,1,2] out [0]
b2       lane 2 in [2] through [0,1] out [0]
b1       lane 1 in [1] through [0] out [0]
a        lane 0 in [0] through [] out []",
        );
    }

    #[test]
    fn snapshot_criss_cross() {
        let mut f = Fixture::new();
        f.commit("a");
        f.branch("x");
        f.commit("x1");
        f.switch("main");
        f.branch("y");
        f.commit("y1");
        // Each side merges the other's first commit: two merges with crossing parents.
        f.switch("x");
        f.merge(&["y"], "mx");
        f.switch("y");
        f.merge(&["x~1"], "my");
        f.switch("main");
        f.merge(&["x", "y"], "final");
        assert_snapshot(
            &f.snapshot(),
            "final    lane 0 in [] through [] out [0,1,2]
my       lane 2 in [2] through [0,1] out [2,3]
mx       lane 1 in [1] through [0,2,3] out [3,2]
y1       lane 2 in [2] through [0,3] out [0]
x1       lane 3 in [3] through [0] out [0]
a        lane 0 in [0] through [] out []",
        );
    }

    /// Every row's edges must connect: an incoming edge needs a child above, and no lane may
    /// be used by two different commits in the same row.
    #[test]
    fn shapes_obey_lane_invariants() {
        let mut f = Fixture::new();
        f.commit("a");
        f.branch("x");
        f.commit("x1");
        f.switch("main");
        f.commit("m1");
        f.merge(&["x"], "m");
        let repo = gix::open(f.git.root()).unwrap();
        walk_commits(&repo, 100, &AtomicBool::new(false), |rows| {
            for r in rows {
                let mut used: Vec<u16> = r.graph.through.iter().map(|(l, _)| *l).collect();
                used.push(r.graph.lane);
                let n = used.len();
                used.sort_unstable();
                used.dedup();
                assert_eq!(used.len(), n, "a lane is used twice in row {}", r.summary);
            }
            true
        })
        .unwrap();
    }

    fn assert_snapshot(actual: &str, expected: &str) {
        assert_eq!(
            actual, expected,
            "lane layout changed:
{actual}"
        );
    }
}
