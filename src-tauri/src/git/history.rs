//! Per-file history (`git log --follow`) and blame (`git blame --porcelain`), plus the
//! repository's commit template.

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

/// Most commits returned for one file; history beyond this is rarely wanted in a list.
const MAX_FILE_COMMITS: usize = 1000;
/// Blame output is capped so a huge generated file cannot flood the webview.
const MAX_BLAME_LINES: usize = 20_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileCommit {
    pub oid: String,
    pub summary: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
}

/// Commits that touched `path`, newest first, following renames.
pub fn file_history(git: &Git, path: &str) -> Result<Vec<FileCommit>> {
    let path = validate::rel_path(path)?;
    let limit = format!("-n{MAX_FILE_COMMITS}");
    let out = git.output([
        "log",
        "--follow",
        "--format=%H%x00%an%x00%ct%x00%s",
        limit.as_str(),
        "--",
        path,
    ])?;
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let mut f = line.split('\0');
        let (Some(oid), Some(author), Some(time), Some(summary)) =
            (f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        commits.push(FileCommit {
            oid: oid.to_string(),
            author: author.to_string(),
            time: time.parse().unwrap_or(0),
            summary: summary.to_string(),
        });
    }
    Ok(commits)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BlameLine {
    /// 1-based line number in the file as of the blamed revision.
    pub line: u32,
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Blame {
    pub lines: Vec<BlameLine>,
    /// The file has more lines than `MAX_BLAME_LINES`.
    pub truncated: bool,
}

#[derive(Default, Clone)]
struct Meta {
    author: String,
    time: i64,
    summary: String,
}

/// Parses `git blame --porcelain`. Each line starts with a header `<oid> <orig> <final> [<group>]`;
/// the first time an oid appears it is followed by `author`, `author-time`, `summary` and other
/// metadata; the line's content follows after a tab. Later lines of the same commit repeat only
/// the header.
pub fn parse_blame(raw: &[u8]) -> Blame {
    let mut metas: std::collections::HashMap<String, Meta> = std::collections::HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    let mut truncated = false;

    for line in raw.split(|&b| b == b'\n') {
        if let Some(content) = line.strip_prefix(b"\t") {
            let Some((oid, number)) = current.take() else {
                continue;
            };
            if lines.len() >= MAX_BLAME_LINES {
                truncated = true;
                break;
            }
            let meta = metas.get(&oid).cloned().unwrap_or_default();
            lines.push(BlameLine {
                line: number,
                oid,
                author: meta.author,
                time: meta.time,
                summary: meta.summary,
                text: String::from_utf8_lossy(content).into_owned(),
            });
            continue;
        }
        let text = String::from_utf8_lossy(line);
        let mut parts = text.split(' ');
        let first = parts.next().unwrap_or("");
        let is_header = first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit());
        if is_header {
            let _orig = parts.next();
            let final_line = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            current = Some((first.to_string(), final_line));
            metas.entry(first.to_string()).or_default();
        } else if let Some((oid, _)) = &current {
            let meta = metas.entry(oid.clone()).or_default();
            if let Some(v) = text.strip_prefix("author ") {
                meta.author = v.to_string();
            } else if let Some(v) = text.strip_prefix("author-time ") {
                meta.time = v.parse().unwrap_or(0);
            } else if let Some(v) = text.strip_prefix("summary ") {
                meta.summary = v.to_string();
            }
        }
    }
    Blame { lines, truncated }
}

/// Who last changed each line of `path` (as of `rev`, or the working tree's HEAD when absent).
pub fn blame(git: &Git, path: &str, rev: Option<&str>) -> Result<Blame> {
    let path = validate::rel_path(path)?;
    let rev = rev.map(validate::oid).transpose()?.map(|o| o.to_string());
    let mut args = vec!["blame", "--porcelain", "-w"];
    if let Some(r) = &rev {
        args.push(r);
    }
    args.extend(["--", path]);
    let out = git.output(args)?;
    Ok(parse_blame(&out))
}

/// The contents of the file named by `commit.template`, if configured and readable.
pub fn commit_template(git: &Git) -> Result<Option<String>> {
    let Ok(out) = git.output(["config", "--path", "--get", "commit.template"]) else {
        return Ok(None);
    };
    let configured = String::from_utf8_lossy(&out).trim().to_string();
    if configured.is_empty() {
        return Ok(None);
    }
    let path = std::path::Path::new(&configured);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        git.root().join(path)
    };
    match std::fs::metadata(&full) {
        Ok(m) if m.is_file() && m.len() <= 64 * 1024 => Ok(std::fs::read_to_string(full).ok()),
        Ok(_) => Err(AppError::Git(
            "the commit template is not a small text file".into(),
        )),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    #[test]
    fn history_follows_renames_and_lists_only_touching_commits() {
        let (_d, git) = init_repo();
        commit_file(&git, "old.txt", "one\ntwo\nthree\nfour\n", "create");
        commit_file(&git, "other.txt", "x\n", "unrelated");
        git.output(["mv", "old.txt", "new.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "rename"]).unwrap();
        commit_file(&git, "new.txt", "one\ntwo\nthree\nfour\nfive\n", "append");

        let h = file_history(&git, "new.txt").unwrap();
        let summaries: Vec<_> = h.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, ["append", "rename", "create"]);
        assert!(h.iter().all(|c| c.oid.len() == 40 && c.author == "Tester"));
        assert!(file_history(&git, "../x").is_err());
        assert!(file_history(&git, "").is_err());
    }

    #[test]
    fn blame_attributes_each_line_to_the_commit_that_introduced_it() {
        let (_d, git) = init_repo();
        commit_file(&git, "b.txt", "alpha\nbeta\n", "first");
        commit_file(&git, "b.txt", "alpha\nbeta\ngamma\n", "second: add gamma");

        let b = blame(&git, "b.txt", None).unwrap();
        assert!(!b.truncated);
        assert_eq!(b.lines.len(), 3);
        assert_eq!(b.lines[0].text, "alpha");
        assert_eq!(b.lines[0].summary, "first");
        assert_eq!(b.lines[2].text, "gamma");
        assert_eq!(b.lines[2].summary, "second: add gamma");
        assert_eq!(
            b.lines[0].oid, b.lines[1].oid,
            "both came from the first commit"
        );
        assert_ne!(b.lines[0].oid, b.lines[2].oid);
        assert_eq!(
            b.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(b.lines[0].author, "Tester");
        assert!(b.lines[0].time > 0);
    }

    #[test]
    fn blame_at_an_older_revision_and_bad_input() {
        let (_d, git) = init_repo();
        commit_file(&git, "b.txt", "one\n", "first");
        let first = String::from_utf8_lossy(&git.output(["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string();
        commit_file(&git, "b.txt", "one\ntwo\n", "second");
        assert_eq!(blame(&git, "b.txt", Some(&first)).unwrap().lines.len(), 1);
        assert!(blame(&git, "b.txt", Some("--all")).is_err());
        assert!(blame(&git, "nope.txt", None).is_err());
        assert!(blame(&git, "../b.txt", None).is_err());
    }

    #[test]
    fn parse_blame_handles_tabs_and_missing_metadata() {
        let oid = "a".repeat(40);
        let raw = format!(
            "{oid} 1 1 2\nauthor Ada\nauthor-time 1700000000\nsummary Hello\nfilename f\n\tfirst\twith tab\n{oid} 2 2\n\t\n"
        );
        let b = parse_blame(raw.as_bytes());
        assert_eq!(b.lines.len(), 2);
        assert_eq!(b.lines[0].text, "first\twith tab");
        assert_eq!(
            b.lines[1].author, "Ada",
            "metadata is reused for later lines of a commit"
        );
        assert_eq!(b.lines[1].text, "");
    }

    #[test]
    fn commit_template_is_read_when_configured() {
        let (d, git) = init_repo();
        assert_eq!(commit_template(&git).unwrap(), None);
        std::fs::write(d.path().join("tmpl.txt"), "Subject\n\nWhy:\n").unwrap();
        git.output(["config", "commit.template", "tmpl.txt"])
            .unwrap();
        assert_eq!(
            commit_template(&git).unwrap().as_deref(),
            Some("Subject\n\nWhy:\n")
        );
        git.output(["config", "commit.template", "missing.txt"])
            .unwrap();
        assert_eq!(commit_template(&git).unwrap(), None);
    }
}
