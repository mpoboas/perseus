use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefInfo {
    /// Short name, e.g. `main`, `origin/main`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// The commit the ref (after peeling annotated tags) points at.
    pub target: String,
    /// True for the currently checked-out branch.
    pub is_head: bool,
    /// Upstream of a local branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream branch was deleted on the remote.
    pub gone: bool,
}

pub fn list_refs(repo: &gix::Repository) -> Result<Vec<RefInfo>> {
    let head_name = repo.head_name().map_err(AppError::git)?;
    let mut out = Vec::new();

    let platform = repo.references().map_err(AppError::git)?;
    for reference in platform.all().map_err(AppError::git)? {
        let mut reference = reference.map_err(AppError::git)?;
        let full = reference.name().as_bstr().to_string();
        let kind = if full.starts_with("refs/heads/") {
            RefKind::Branch
        } else if full.starts_with("refs/remotes/") {
            RefKind::Remote
        } else if full.starts_with("refs/tags/") {
            RefKind::Tag
        } else {
            continue;
        };
        let name = reference.name().shorten().to_string();
        let Ok(id) = reference.peel_to_id() else {
            continue;
        };
        let id = id.detach();
        if !repo.find_object(id).is_ok_and(|o| o.kind.is_commit()) {
            continue;
        }
        let is_head = head_name
            .as_ref()
            .is_some_and(|h| h.as_bstr() == full.as_bytes());
        out.push(RefInfo {
            name,
            kind,
            target: id.to_string(),
            is_head,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone: false,
        });
    }
    out.sort_by_key(|r| r.name.to_lowercase());
    Ok(out)
}

/// Parses git's `%(upstream:track)` text: `[ahead 2, behind 1]`, `[ahead 3]`, `[behind 1]`, `[gone]` or empty.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// Fills in upstream, ahead and behind for local branches. Best effort: any failure
/// leaves the refs as they were rather than breaking the whole list.
pub fn attach_upstreams(git: &Git, refs: &mut [RefInfo]) {
    let Ok(raw) = git.output([
        "for-each-ref",
        "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
    ]) else {
        return;
    };
    for line in String::from_utf8_lossy(&raw).lines() {
        let mut f = line.split('\0');
        let (Some(name), Some(upstream), Some(track)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if upstream.is_empty() {
            continue;
        }
        if let Some(r) = refs
            .iter_mut()
            .find(|r| r.kind == RefKind::Branch && r.name == name)
        {
            let (ahead, behind, gone) = parse_track(track);
            r.upstream = Some(upstream.to_string());
            r.ahead = ahead;
            r.behind = behind;
            r.gone = gone;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn parses_track_text() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[ahead 2]"), (2, 0, false));
        assert_eq!(parse_track("[behind 5]"), (0, 5, false));
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
        assert_eq!(parse_track("[ahead x]"), (0, 0, false));
    }

    #[test]
    fn reports_ahead_behind_and_gone_for_tracking_branches() {
        use crate::git::cli::testutil::*;

        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let url = remote.path().to_str().unwrap().to_string();

        let (_d1, one) = init_repo();
        commit_file(&one, "a.txt", "a\n", "first");
        one.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        one.output(["push", "-q", "-u", "origin", "main"]).unwrap();
        one.output(["switch", "-q", "-c", "topic"]).unwrap();
        one.output(["push", "-q", "-u", "origin", "topic"]).unwrap();
        one.output(["switch", "-q", "main"]).unwrap();

        // Someone else pushes to main; we commit locally too: ahead 1, behind 1.
        let (_d2, two) = init_repo();
        two.output(["remote", "add", "origin", url.as_str()])
            .unwrap();
        two.output(["fetch", "-q", "origin"]).unwrap();
        two.output(["reset", "-q", "--hard", "origin/main"])
            .unwrap();
        commit_file(&two, "b.txt", "b\n", "theirs");
        two.output(["push", "-q", "origin", "main"]).unwrap();
        // ...and deletes `topic` upstream.
        two.output(["push", "-q", "origin", "--delete", "topic"])
            .unwrap();

        commit_file(&one, "c.txt", "c\n", "mine");
        one.output(["fetch", "-q", "--prune", "origin"]).unwrap();

        let repo = gix::open(one.root()).unwrap();
        let mut refs = list_refs(&repo).unwrap();
        attach_upstreams(&one, &mut refs);
        let get = |n: &str| refs.iter().find(|r| r.name == n).unwrap().clone();

        let main = get("main");
        assert_eq!(
            (main.upstream.as_deref(), main.ahead, main.behind),
            (Some("origin/main"), 1, 1)
        );
        let topic = get("topic");
        assert!(topic.gone, "deleted upstream should be reported as gone");

        // Branches without an upstream are untouched.
        one.output(["branch", "lonely"]).unwrap();
        let mut again = list_refs(&gix::open(one.root()).unwrap()).unwrap();
        attach_upstreams(&one, &mut again);
        let lonely = again.iter().find(|r| r.name == "lonely").unwrap();
        assert_eq!(
            (
                lonely.upstream.clone(),
                lonely.ahead,
                lonely.behind,
                lonely.gone
            ),
            (None, 0, 0, false)
        );
    }

    #[test]
    fn lists_branches_and_tags_and_marks_head() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let st = Command::new("git")
                .args([
                    "-c",
                    "user.name=T",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(st.status.success(), "{args:?}");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "A"]);
        run(&["branch", "topic"]);
        run(&["tag", "-a", "v1", "-m", "release"]);

        let repo = gix::open(dir.path()).unwrap();
        let refs = list_refs(&repo).unwrap();
        let get = |n: &str| {
            refs.iter()
                .find(|r| r.name == n)
                .unwrap_or_else(|| panic!("{n}"))
        };

        assert_eq!(get("main").kind, RefKind::Branch);
        assert!(get("main").is_head);
        assert!(!get("topic").is_head);
        assert_eq!(get("v1").kind, RefKind::Tag);
        // Annotated tag peels to the commit, not the tag object.
        assert_eq!(get("v1").target, get("main").target);
    }
}
