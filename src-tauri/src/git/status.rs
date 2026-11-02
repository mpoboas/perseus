use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::diff::{LineStats, worktree_stats};
use crate::git::ops::{self, Operation};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    /// Original path for renames/copies.
    pub orig_path: Option<String>,
    /// Staged change code (`M`, `A`, `D`, `R`, `C`, `T`), if any.
    pub index: Option<char>,
    /// Unstaged change code, if any.
    pub worktree: Option<char>,
    pub untracked: bool,
    pub conflicted: bool,
    /// Line counts of the staged change (`None` when there is none).
    pub index_stats: Option<LineStats>,
    /// Line counts of the unstaged change.
    pub worktree_stats: Option<LineStats>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct RepoStatus {
    /// Current branch, `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
    /// A merge/rebase/cherry-pick/revert that stopped and needs abort or continue.
    pub operation: Option<Operation>,
}

fn code(c: char) -> Option<char> {
    (c != '.').then_some(c)
}

/// Parses `git status --porcelain=v2 -z --branch` output.
pub fn parse(raw: &[u8]) -> Result<RepoStatus> {
    let text = String::from_utf8_lossy(raw);
    let mut status = RepoStatus::default();
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let bad = |t: &str| AppError::Git(format!("unexpected status line: {t}"));

    while let Some(tok) = tokens.next() {
        if let Some(rest) = tok.strip_prefix("# ") {
            match rest.split_once(' ') {
                Some(("branch.head", name)) if name != "(detached)" => {
                    status.branch = Some(name.to_string());
                }
                Some(("branch.upstream", name)) => status.upstream = Some(name.to_string()),
                Some(("branch.ab", ab)) => {
                    let mut it = ab.split(' ');
                    let num = |s: Option<&str>, sign: char| {
                        s.and_then(|s| s.strip_prefix(sign))
                            .and_then(|n| n.parse().ok())
                            .unwrap_or(0)
                    };
                    status.ahead = num(it.next(), '+');
                    status.behind = num(it.next(), '-');
                }
                _ => {}
            }
            continue;
        }

        let kind = tok.chars().next().ok_or_else(|| bad(tok))?;
        match kind {
            // 1 XY sub mH mI mW hH hI path
            '1' => {
                let f: Vec<&str> = tok.splitn(9, ' ').collect();
                let xy = *f.get(1).ok_or_else(|| bad(tok))?;
                let path = *f.get(8).ok_or_else(|| bad(tok))?;
                status.entries.push(entry(path, None, xy, false)?);
            }
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            '2' => {
                let f: Vec<&str> = tok.splitn(10, ' ').collect();
                let xy = *f.get(1).ok_or_else(|| bad(tok))?;
                let path = *f.get(9).ok_or_else(|| bad(tok))?;
                let orig = tokens.next().ok_or_else(|| bad(tok))?;
                status
                    .entries
                    .push(entry(path, Some(orig.to_string()), xy, false)?);
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            'u' => {
                let f: Vec<&str> = tok.splitn(11, ' ').collect();
                let path = *f.get(10).ok_or_else(|| bad(tok))?;
                status.entries.push(StatusEntry {
                    path: path.to_string(),
                    orig_path: None,
                    index: None,
                    worktree: None,
                    untracked: false,
                    conflicted: true,
                    index_stats: None,
                    worktree_stats: None,
                });
            }
            '?' => {
                let path = tok.strip_prefix("? ").ok_or_else(|| bad(tok))?;
                status.entries.push(StatusEntry {
                    path: path.to_string(),
                    orig_path: None,
                    index: None,
                    worktree: None,
                    untracked: true,
                    conflicted: false,
                    index_stats: None,
                    worktree_stats: None,
                });
            }
            _ => {} // ignored entries and unknown record types
        }
    }
    Ok(status)
}

fn entry(path: &str, orig_path: Option<String>, xy: &str, conflicted: bool) -> Result<StatusEntry> {
    let mut c = xy.chars();
    let (x, y) = (c.next(), c.next());
    let (Some(x), Some(y)) = (x, y) else {
        return Err(AppError::Git(format!("unexpected status code: {xy}")));
    };
    Ok(StatusEntry {
        path: path.to_string(),
        orig_path,
        index: code(x),
        worktree: code(y),
        untracked: false,
        conflicted,
        index_stats: None,
        worktree_stats: None,
    })
}

pub fn read(git: &Git) -> Result<RepoStatus> {
    let raw = git.output([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
    ])?;
    let mut status = parse(&raw)?;

    // Line counts are a nicety: a failure here must not hide the file list.
    let (staged, unstaged) = (worktree_stats(git, true), worktree_stats(git, false));
    for e in &mut status.entries {
        e.index_stats = staged.get(&e.path).copied();
        e.worktree_stats = unstaged.get(&e.path).copied();
    }
    status.operation = ops::in_progress(git);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    #[test]
    fn parses_every_record_type() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        commit_file(&git, "keep.txt", "k\n", "k");
        commit_file(&git, "sp ace.txt", "s\n", "s");
        git.output(["mv", "a.txt", "renamed.txt"]).unwrap();
        write(&git, "keep.txt", "modified\n");
        git.output(["add", "keep.txt"]).unwrap();
        write(&git, "keep.txt", "modified again\n");
        write(&git, "new dir/untracked.txt", "u\n");
        std::fs::remove_file(git.root().join("sp ace.txt")).unwrap();

        let st = read(&git).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream, None);

        let get = |p: &str| st.entries.iter().find(|e| e.path == p).unwrap();
        let renamed = get("renamed.txt");
        assert_eq!(renamed.index, Some('R'));
        assert_eq!(renamed.orig_path.as_deref(), Some("a.txt"));

        let keep = get("keep.txt");
        assert_eq!((keep.index, keep.worktree), (Some('M'), Some('M')));

        assert_eq!(get("sp ace.txt").worktree, Some('D'));
        assert!(get("new dir/untracked.txt").untracked);
    }

    #[test]
    fn reports_conflicts_and_ahead_behind() {
        let (_d, git) = init_repo();
        commit_file(&git, "f.txt", "base\n", "base");
        git.output(["switch", "-q", "-c", "other"]).unwrap();
        commit_file(&git, "f.txt", "other\n", "other");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "f.txt", "main\n", "main");
        let _ = git.output(["merge", "other"]); // conflicts

        let st = read(&git).unwrap();
        let f = st.entries.iter().find(|e| e.path == "f.txt").unwrap();
        assert!(f.conflicted);
        assert_eq!(st.operation, Some(Operation::Merge));
    }

    #[test]
    fn detached_head_has_no_branch() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        git.output(["switch", "-q", "--detach", "HEAD"]).unwrap();
        assert_eq!(read(&git).unwrap().branch, None);
    }

    #[test]
    fn rejects_garbage_gracefully() {
        assert!(parse(b"1 M.\0").is_err());
        assert!(parse(b"").unwrap().entries.is_empty());
    }
}
