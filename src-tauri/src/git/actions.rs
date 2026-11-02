//! Everyday actions that finish quickly: stash, tags, branch management, reset, revert,
//! discarding changes and remote management. One tagged enum keeps the IPC surface to a single
//! command; each variant validates its inputs, then runs one git command.
//!
//! Long-running network operations (fetch, pull, push) live in `ops.rs`, where progress streams.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::patch::{self, HunkSelection, PatchMode};
use crate::git::validate;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    /// Move the branch only; keep index and files.
    Soft,
    /// Move the branch and reset the index; keep files.
    Mixed,
    /// Move the branch and discard every change in index and files.
    Hard,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    StashPush {
        message: Option<String>,
        #[serde(default)]
        include_untracked: bool,
    },
    StashApply {
        index: u32,
    },
    StashPop {
        index: u32,
    },
    StashDrop {
        index: u32,
    },
    TagCreate {
        name: String,
        /// Commit or ref to tag; the current commit when absent.
        target: Option<String>,
        /// A message makes the tag annotated.
        message: Option<String>,
    },
    TagDelete {
        name: String,
    },
    TagPush {
        name: String,
        remote: Option<String>,
    },
    TagDeleteRemote {
        name: String,
        remote: Option<String>,
    },
    BranchDelete {
        name: String,
        /// Delete even when the branch has commits that are not merged anywhere else.
        #[serde(default)]
        force: bool,
    },
    BranchDeleteRemote {
        remote: String,
        name: String,
    },
    BranchRename {
        old: String,
        new: String,
    },
    /// Sets the upstream of `branch`, or removes it when `upstream` is absent.
    SetUpstream {
        branch: String,
        upstream: Option<String>,
    },
    Reset {
        mode: ResetMode,
        target: String,
    },
    Revert {
        oid: String,
        /// Which parent to treat as the mainline when reverting a merge commit (1-based).
        mainline: Option<u32>,
    },
    /// Throws away local changes to the given paths. Untracked files are deleted.
    Discard {
        paths: Vec<String>,
        #[serde(default)]
        untracked: bool,
    },
    /// Stage, unstage or discard chosen hunks or lines of one file.
    Patch {
        path: String,
        mode: PatchMode,
        hunks: Vec<HunkSelection>,
    },
    RemoteAdd {
        name: String,
        url: String,
    },
    RemoteRemove {
        name: String,
    },
    RemoteRename {
        old: String,
        new: String,
    },
    RemoteSetUrl {
        name: String,
        url: String,
    },
}

/// A commit id or ref name, never something that parses as an option.
fn rev(s: &str) -> Result<String> {
    match validate::oid(s) {
        Ok(id) => Ok(id.to_string()),
        Err(_) => validate::ref_name(s).map(str::to_string),
    }
}

fn remote_or_origin(remote: &Option<String>) -> Result<&str> {
    validate::remote_name(remote.as_deref().unwrap_or("origin"))
}

pub fn run(git: &Git, action: &Action) -> Result<()> {
    match action {
        Action::StashPush {
            message,
            include_untracked,
        } => {
            let mut args = vec!["stash", "push"];
            if *include_untracked {
                args.push("--include-untracked");
            }
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                if m.contains('\0') {
                    return Err(AppError::Git("invalid stash message".into()));
                }
                args.extend(["-m", m]);
            }
            // `git stash --include-untracked` runs its own pathspec commands internally, and
            // literal-pathspec mode (our default) makes them match nothing, so untracked files
            // would silently be left out. This command takes no pathspec from the user.
            git.clone()
                .with_env("GIT_LITERAL_PATHSPECS", "0")
                .output(args)?;
        }
        Action::StashApply { index } => {
            git.output(["stash", "apply", "--index", &format!("stash@{{{index}}}")])?;
        }
        Action::StashPop { index } => {
            git.output(["stash", "pop", "--index", &format!("stash@{{{index}}}")])?;
        }
        Action::StashDrop { index } => {
            git.output(["stash", "drop", &format!("stash@{{{index}}}")])?;
        }
        Action::TagCreate {
            name,
            target,
            message,
        } => {
            let name = validate::ref_name(name)?;
            let target = target.as_deref().map(rev).transpose()?;
            let mut args = vec!["tag"];
            let msg = message.as_deref().filter(|m| !m.trim().is_empty());
            if let Some(m) = msg {
                if m.contains('\0') {
                    return Err(AppError::Git("invalid tag message".into()));
                }
                args.extend(["-a", "-m", m]);
            }
            args.push(name);
            if let Some(t) = &target {
                args.push(t);
            }
            git.output(args)?;
        }
        Action::TagDelete { name } => {
            git.output(["tag", "-d", validate::ref_name(name)?])?;
        }
        Action::TagPush { name, remote } => {
            let refspec = format!("refs/tags/{}", validate::ref_name(name)?);
            git.output(["push", remote_or_origin(remote)?, &refspec])?;
        }
        Action::TagDeleteRemote { name, remote } => {
            let refspec = format!(":refs/tags/{}", validate::ref_name(name)?);
            git.output(["push", remote_or_origin(remote)?, &refspec])?;
        }
        Action::BranchDelete { name, force } => {
            let flag = if *force { "-D" } else { "-d" };
            git.output(["branch", flag, validate::ref_name(name)?])?;
        }
        Action::BranchDeleteRemote { remote, name } => {
            git.output([
                "push",
                validate::remote_name(remote)?,
                "--delete",
                validate::ref_name(name)?,
            ])?;
        }
        Action::BranchRename { old, new } => {
            git.output([
                "branch",
                "-m",
                validate::ref_name(old)?,
                validate::ref_name(new)?,
            ])?;
        }
        Action::SetUpstream { branch, upstream } => {
            let branch = validate::ref_name(branch)?;
            match upstream {
                Some(up) => {
                    let flag = format!("--set-upstream-to={}", validate::ref_name(up)?);
                    git.output(["branch", flag.as_str(), branch])?;
                }
                None => {
                    git.output(["branch", "--unset-upstream", branch])?;
                }
            }
        }
        Action::Reset { mode, target } => {
            let flag = match mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Hard => "--hard",
            };
            git.output(["reset", "-q", flag, rev(target)?.as_str()])?;
        }
        Action::Revert { oid, mainline } => {
            let oid = validate::oid(oid)?.to_string();
            let mut args = vec!["revert".to_string(), "--no-edit".to_string()];
            if let Some(m) = mainline {
                if *m == 0 {
                    return Err(AppError::Git("mainline parent numbers start at 1".into()));
                }
                args.extend(["-m".to_string(), m.to_string()]);
            }
            args.push(oid);
            git.output(args)?;
        }
        Action::Discard { paths, untracked } => {
            if paths.is_empty() {
                return Err(AppError::Git("no paths given".into()));
            }
            let paths: Vec<&str> = paths
                .iter()
                .map(|p| validate::rel_path(p))
                .collect::<Result<_>>()?;
            if *untracked {
                git.output(["clean", "-f", "-d", "--"].into_iter().chain(paths))?;
            } else {
                // Restores both the index entry and the file, so staged and unstaged changes go.
                git.output(
                    ["restore", "--staged", "--worktree", "--"]
                        .into_iter()
                        .chain(paths),
                )?;
            }
        }
        Action::Patch { path, mode, hunks } => patch::apply_selection(git, path, *mode, hunks)?,
        Action::RemoteAdd { name, url } => {
            git.output([
                "remote",
                "add",
                validate::remote_name(name)?,
                validate::remote_url(url)?,
            ])?;
        }
        Action::RemoteRemove { name } => {
            git.output(["remote", "remove", validate::remote_name(name)?])?;
        }
        Action::RemoteRename { old, new } => {
            git.output([
                "remote",
                "rename",
                validate::remote_name(old)?,
                validate::remote_name(new)?,
            ])?;
        }
        Action::RemoteSetUrl { name, url } => {
            git.output([
                "remote",
                "set-url",
                validate::remote_name(name)?,
                validate::remote_url(url)?,
            ])?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    /// Unix seconds.
    pub time: i64,
}

pub fn list_stashes(git: &Git) -> Result<Vec<StashEntry>> {
    let out = git.output(["stash", "list", "--format=%gd%x00%gs%x00%ct"])?;
    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let mut f = line.split('\0');
        let (Some(sel), Some(msg), Some(time)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let Some(index) = sel
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|s| s.parse().ok())
        else {
            continue;
        };
        entries.push(StashEntry {
            index,
            message: msg.to_string(),
            time: time.parse().unwrap_or(0),
        });
    }
    Ok(entries)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

pub fn list_remotes(git: &Git) -> Result<Vec<RemoteInfo>> {
    let out = git.output(["remote", "-v"])?;
    let mut remotes: Vec<RemoteInfo> = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        // `origin<TAB>https://host/x.git (fetch)`
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let Some((url, kind)) = rest.rsplit_once(' ') else {
            continue;
        };
        let entry = match remotes.iter_mut().find(|r| r.name == name) {
            Some(r) => r,
            None => {
                remotes.push(RemoteInfo {
                    name: name.to_string(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                remotes.last_mut().expect("just pushed")
            }
        };
        match kind {
            "(fetch)" => entry.fetch_url = url.to_string(),
            "(push)" => entry.push_url = url.to_string(),
            _ => {}
        }
    }
    Ok(remotes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn rev_parse(git: &Git, what: &str) -> String {
        String::from_utf8_lossy(&git.output(["rev-parse", what]).unwrap())
            .trim()
            .to_string()
    }

    fn branches(git: &Git) -> Vec<String> {
        String::from_utf8_lossy(&git.output(["branch", "--format=%(refname:short)"]).unwrap())
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn stash_push_list_apply_pop_drop() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        write(&git, "a.txt", "changed\n");
        write(&git, "new.txt", "untracked\n");

        run(
            &git,
            &Action::StashPush {
                message: Some("wip: my change".into()),
                include_untracked: true,
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(git.root().join("a.txt")).unwrap(),
            "a\n"
        );
        assert!(!git.root().join("new.txt").exists());

        let list = list_stashes(&git).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert!(list[0].message.contains("wip: my change"), "{:?}", list[0]);

        run(&git, &Action::StashApply { index: 0 }).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.root().join("a.txt")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            list_stashes(&git).unwrap().len(),
            1,
            "apply keeps the stash"
        );

        git.output(["checkout", "--", "a.txt"]).unwrap();
        git.output(["clean", "-fdq"]).unwrap();
        run(&git, &Action::StashPop { index: 0 }).unwrap();
        assert!(
            list_stashes(&git).unwrap().is_empty(),
            "pop removes the stash"
        );

        run(
            &git,
            &Action::StashPush {
                message: None,
                include_untracked: false,
            },
        )
        .unwrap();
        run(&git, &Action::StashDrop { index: 0 }).unwrap();
        assert!(list_stashes(&git).unwrap().is_empty());
    }

    #[test]
    fn tags_lightweight_annotated_and_delete() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        commit_file(&git, "b.txt", "b\n", "b");
        let first = rev_parse(&git, "HEAD~1");

        run(
            &git,
            &Action::TagCreate {
                name: "light".into(),
                target: Some(first.clone()),
                message: None,
            },
        )
        .unwrap();
        run(
            &git,
            &Action::TagCreate {
                name: "v1.0".into(),
                target: None,
                message: Some("release".into()),
            },
        )
        .unwrap();
        let kind = |t: &str| {
            String::from_utf8_lossy(&git.output(["cat-file", "-t", t]).unwrap())
                .trim()
                .to_string()
        };
        assert_eq!(kind("light"), "commit");
        assert_eq!(kind("v1.0"), "tag");
        assert_eq!(rev_parse(&git, "light^{commit}"), first);

        run(
            &git,
            &Action::TagDelete {
                name: "light".into(),
            },
        )
        .unwrap();
        assert!(
            git.output(["rev-parse", "-q", "--verify", "refs/tags/light"])
                .is_err()
        );
    }

    #[test]
    fn tags_push_and_delete_on_a_remote() {
        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        git.output(["remote", "add", "origin", remote.path().to_str().unwrap()])
            .unwrap();
        git.output(["tag", "v1"]).unwrap();

        run(
            &git,
            &Action::TagPush {
                name: "v1".into(),
                remote: None,
            },
        )
        .unwrap();
        let rgit = Git::new(remote.path());
        assert!(
            rgit.output(["rev-parse", "-q", "--verify", "refs/tags/v1"])
                .is_ok()
        );

        run(
            &git,
            &Action::TagDeleteRemote {
                name: "v1".into(),
                remote: None,
            },
        )
        .unwrap();
        assert!(
            rgit.output(["rev-parse", "-q", "--verify", "refs/tags/v1"])
                .is_err()
        );
    }

    #[test]
    fn branch_delete_refuses_unmerged_until_forced() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        git.output(["switch", "-q", "-c", "topic"]).unwrap();
        commit_file(&git, "t.txt", "t\n", "t");
        git.output(["switch", "-q", "main"]).unwrap();

        let err = run(
            &git,
            &Action::BranchDelete {
                name: "topic".into(),
                force: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not fully merged"), "{err}");
        assert!(branches(&git).contains(&"topic".to_string()));

        run(
            &git,
            &Action::BranchDelete {
                name: "topic".into(),
                force: true,
            },
        )
        .unwrap();
        assert!(!branches(&git).contains(&"topic".to_string()));
    }

    #[test]
    fn rename_and_upstream_management() {
        let remote = tempfile::tempdir().unwrap();
        Git::new(remote.path())
            .output(["init", "-q", "--bare", "-b", "main"])
            .unwrap();
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        git.output(["remote", "add", "origin", remote.path().to_str().unwrap()])
            .unwrap();
        git.output(["push", "-q", "origin", "main"]).unwrap();
        git.output(["fetch", "-q", "origin"]).unwrap();

        run(
            &git,
            &Action::SetUpstream {
                branch: "main".into(),
                upstream: Some("origin/main".into()),
            },
        )
        .unwrap();
        let up = String::from_utf8_lossy(
            &git.output(["rev-parse", "--abbrev-ref", "main@{u}"])
                .unwrap(),
        )
        .trim()
        .to_string();
        assert_eq!(up, "origin/main");

        run(
            &git,
            &Action::SetUpstream {
                branch: "main".into(),
                upstream: None,
            },
        )
        .unwrap();
        assert!(
            git.output(["rev-parse", "--abbrev-ref", "main@{u}"])
                .is_err()
        );

        run(
            &git,
            &Action::BranchRename {
                old: "main".into(),
                new: "trunk".into(),
            },
        )
        .unwrap();
        assert!(branches(&git).contains(&"trunk".to_string()));

        // And deleting a branch that exists on the remote.
        git.output(["push", "-q", "origin", "trunk"]).unwrap();
        run(
            &git,
            &Action::BranchDeleteRemote {
                remote: "origin".into(),
                name: "trunk".into(),
            },
        )
        .unwrap();
        assert!(
            Git::new(remote.path())
                .output(["rev-parse", "-q", "--verify", "refs/heads/trunk"])
                .is_err()
        );
    }

    #[test]
    fn reset_modes_differ_in_what_they_keep() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        commit_file(&git, "b.txt", "b\n", "b");
        let first = rev_parse(&git, "HEAD~1");
        let second = rev_parse(&git, "HEAD");

        run(
            &git,
            &Action::Reset {
                mode: ResetMode::Soft,
                target: first.clone(),
            },
        )
        .unwrap();
        assert_eq!(rev_parse(&git, "HEAD"), first);
        let staged = git.output(["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&staged).trim(),
            "b.txt",
            "soft keeps the index"
        );

        run(
            &git,
            &Action::Reset {
                mode: ResetMode::Mixed,
                target: second.clone(),
            },
        )
        .unwrap();
        assert!(
            git.output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );

        run(
            &git,
            &Action::Reset {
                mode: ResetMode::Hard,
                target: first.clone(),
            },
        )
        .unwrap();
        assert!(!git.root().join("b.txt").exists(), "hard removes the file");
    }

    #[test]
    fn revert_makes_an_inverse_commit_and_handles_merges() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        commit_file(&git, "b.txt", "b\n", "add b");
        let b = rev_parse(&git, "HEAD");
        run(
            &git,
            &Action::Revert {
                oid: b,
                mainline: None,
            },
        )
        .unwrap();
        assert!(!git.root().join("b.txt").exists());

        // Merge commits need a mainline parent.
        git.output(["switch", "-q", "-c", "topic"]).unwrap();
        commit_file(&git, "t.txt", "t\n", "t");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "m.txt", "m\n", "m");
        git.output(["merge", "--no-ff", "-q", "-m", "merge", "topic"])
            .unwrap();
        let merge = rev_parse(&git, "HEAD");
        assert!(
            run(
                &git,
                &Action::Revert {
                    oid: merge.clone(),
                    mainline: None
                }
            )
            .is_err()
        );
        run(
            &git,
            &Action::Revert {
                oid: merge,
                mainline: Some(1),
            },
        )
        .unwrap();
        assert!(!git.root().join("t.txt").exists());
        assert!(
            run(
                &git,
                &Action::Revert {
                    oid: rev_parse(&git, "HEAD"),
                    mainline: Some(0)
                }
            )
            .is_err()
        );
    }

    #[test]
    fn discard_restores_tracked_files_and_deletes_untracked_ones() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        write(&git, "a.txt", "scribbles\n");
        git.output(["add", "a.txt"]).unwrap();
        write(&git, "a.txt", "more scribbles\n");
        write(&git, "junk.txt", "junk\n");

        run(
            &git,
            &Action::Discard {
                paths: vec!["a.txt".into()],
                untracked: false,
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(git.root().join("a.txt")).unwrap(),
            "a\n"
        );
        assert!(
            git.output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );

        run(
            &git,
            &Action::Discard {
                paths: vec!["junk.txt".into()],
                untracked: true,
            },
        )
        .unwrap();
        assert!(!git.root().join("junk.txt").exists());
    }

    #[test]
    fn remotes_can_be_managed_and_listed() {
        let (_d, git) = init_repo();
        run(
            &git,
            &Action::RemoteAdd {
                name: "origin".into(),
                url: "https://example.com/a.git".into(),
            },
        )
        .unwrap();
        run(
            &git,
            &Action::RemoteAdd {
                name: "fork".into(),
                url: "git@example.com:me/a.git".into(),
            },
        )
        .unwrap();
        let list = list_remotes(&git).unwrap();
        assert_eq!(list.len(), 2);
        let origin = list.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(origin.fetch_url, "https://example.com/a.git");
        assert_eq!(origin.push_url, "https://example.com/a.git");

        run(
            &git,
            &Action::RemoteSetUrl {
                name: "fork".into(),
                url: "https://example.com/fork.git".into(),
            },
        )
        .unwrap();
        run(
            &git,
            &Action::RemoteRename {
                old: "fork".into(),
                new: "mine".into(),
            },
        )
        .unwrap();
        run(
            &git,
            &Action::RemoteRemove {
                name: "origin".into(),
            },
        )
        .unwrap();
        let list = list_remotes(&git).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "mine");
        assert_eq!(list[0].fetch_url, "https://example.com/fork.git");
    }

    #[test]
    fn hostile_inputs_never_reach_git() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        let bad = [
            Action::TagCreate {
                name: "--force".into(),
                target: None,
                message: None,
            },
            Action::TagDelete { name: "-d".into() },
            Action::BranchDelete {
                name: "--all".into(),
                force: true,
            },
            Action::BranchRename {
                old: "main".into(),
                new: "-x".into(),
            },
            Action::Reset {
                mode: ResetMode::Hard,
                target: "--keep".into(),
            },
            Action::Revert {
                oid: "HEAD".into(),
                mainline: None,
            },
            Action::Discard {
                paths: vec!["../x".into()],
                untracked: true,
            },
            Action::Discard {
                paths: vec![],
                untracked: false,
            },
            Action::RemoteAdd {
                name: "ok".into(),
                url: "--upload-pack=evil".into(),
            },
            Action::RemoteAdd {
                name: "ok".into(),
                url: "ext::sh -c evil".into(),
            },
            Action::RemoteAdd {
                name: "a b".into(),
                url: "https://x/y".into(),
            },
            Action::TagPush {
                name: "v1".into(),
                remote: Some("-o".into()),
            },
            Action::StashPush {
                message: Some("a\0b".into()),
                include_untracked: false,
            },
        ];
        for a in &bad {
            assert!(run(&git, a).is_err(), "{a:?} was accepted");
        }
        // Nothing was damaged.
        assert!(git.root().join("a.txt").exists());
        assert_eq!(branches(&git), vec!["main"]);
    }
}
