//! Less common parts of a repository: submodules, linked worktrees, Git LFS and files that are
//! too large to commit comfortably.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

// ---------------------------------------------------------------- submodules

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    /// Checked out at the commit the parent project records.
    Clean,
    /// Registered but not downloaded yet.
    Uninitialized,
    /// Checked out at a different commit than the parent records.
    Modified,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Submodule {
    pub path: String,
    pub state: SubmoduleState,
    /// The commit the parent project records.
    pub oid: String,
    /// `git describe` of the checked-out commit, when it has one.
    pub describe: Option<String>,
}

/// Parses `git submodule status`: `<flag><oid> <path> (<describe>)`.
pub fn parse_submodules(text: &str) -> Vec<Submodule> {
    text.lines()
        .filter_map(|line| {
            let flag = line.chars().next()?;
            let rest = &line[flag.len_utf8()..];
            let (oid, rest) = rest.split_once(' ')?;
            let (path, describe) = match rest.rsplit_once(" (") {
                Some((p, d)) => (p, Some(d.trim_end_matches(')').to_string())),
                None => (rest, None),
            };
            let state = match flag {
                '-' => SubmoduleState::Uninitialized,
                '+' => SubmoduleState::Modified,
                'U' => SubmoduleState::Conflicted,
                _ => SubmoduleState::Clean,
            };
            (oid.len() >= 7 && oid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| Submodule {
                path: path.trim().to_string(),
                state,
                oid: oid.to_string(),
                describe,
            })
        })
        .collect()
}

pub fn list_submodules(git: &Git) -> Result<Vec<Submodule>> {
    let out = git.output(["submodule", "status"])?;
    Ok(parse_submodules(&String::from_utf8_lossy(&out)))
}

/// Downloads (initialises) and checks out the submodules, or just one of them.
pub fn update_submodules(git: &Git, path: Option<&str>) -> Result<()> {
    // Local file transports are off by default for submodules for good security reasons; the
    // caller's own configuration decides, we do not loosen it.
    let mut args = vec!["submodule", "update", "--init", "--recursive"];
    if let Some(p) = path {
        args.push("--");
        args.push(validate::rel_path(p)?);
    }
    git.output(args)?;
    Ok(())
}

/// Adds a submodule: clones `url` into `path`, records it in `.gitmodules` and stages both. The
/// commit that makes it part of the project is left to the user.
pub fn add_submodule(git: &Git, url: &str, path: &str) -> Result<()> {
    let url = validate::remote_url(url)?;
    let path = validate::rel_path(path.trim_end_matches('/'))?;
    // Git blocks the `file` transport for submodules by default, so that a hostile `.gitmodules`
    // cannot make a clone read other repositories on this disk. A folder the user typed here is
    // their own choice, so it is allowed for this one command and the default stays for the rest.
    let local = url.starts_with("file://") || std::path::Path::new(url).is_dir();
    let git = if local {
        git.clone().with_config("protocol.file.allow", "always")
    } else {
        git.clone()
    };
    git.output(["submodule", "add", "--", url, path])?;
    Ok(())
}

// ---------------------------------------------------------------- worktrees

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    pub head: String,
    /// Checked-out branch (short name), or `None` for a detached HEAD.
    pub branch: Option<String>,
    /// The repository's own working directory (it cannot be removed).
    pub is_main: bool,
    pub locked: bool,
}

pub fn parse_worktrees(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut w = Worktree {
            path: String::new(),
            head: String::new(),
            branch: None,
            is_main: false,
            locked: false,
        };
        for line in block.lines() {
            if let Some(v) = line.strip_prefix("worktree ") {
                w.path = v.to_string();
            } else if let Some(v) = line.strip_prefix("HEAD ") {
                w.head = v.to_string();
            } else if let Some(v) = line.strip_prefix("branch ") {
                w.branch = Some(v.trim_start_matches("refs/heads/").to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                w.locked = true;
            }
        }
        if !w.path.is_empty() {
            w.is_main = out.is_empty();
            out.push(w);
        }
    }
    out
}

pub fn list_worktrees(git: &Git) -> Result<Vec<Worktree>> {
    let out = git.output(["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&String::from_utf8_lossy(&out)))
}

/// Adds a linked worktree at `dir` on `branch` (created from the current commit when `create`).
pub fn add_worktree(git: &Git, dir: &std::path::Path, branch: &str, create: bool) -> Result<()> {
    let branch = validate::ref_name(branch)?;
    let dir = dir
        .to_str()
        .ok_or_else(|| AppError::Git("the folder path is not valid text".into()))?;
    if dir.starts_with('-') {
        return Err(AppError::Git("invalid folder".into()));
    }
    let mut args = vec!["worktree", "add"];
    if create {
        args.extend(["-b", branch, "--", dir]);
    } else {
        args.extend(["--", dir, branch]);
    }
    git.output(args)?;
    Ok(())
}

/// Removes a linked worktree. Refuses the main one and one with uncommitted changes (git decides).
pub fn remove_worktree(git: &Git, path: &str) -> Result<()> {
    let listed = list_worktrees(git)?;
    let target = listed
        .iter()
        .find(|w| w.path == path)
        .ok_or_else(|| AppError::Git("that worktree is not part of this repository".into()))?;
    if target.is_main {
        return Err(AppError::Git(
            "the main working directory cannot be removed".into(),
        ));
    }
    git.output(["worktree", "remove", "--", target.path.as_str()])?;
    Ok(())
}

// ---------------------------------------------------------------- Git LFS

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LfsStatus {
    /// The `git lfs` command is installed.
    pub installed: bool,
    /// Patterns tracked through LFS in this repository (from `.gitattributes`).
    pub patterns: Vec<String>,
}

pub fn lfs_status(git: &Git) -> Result<LfsStatus> {
    let installed = git.output(["lfs", "version"]).is_ok();
    let attrs = std::fs::read_to_string(git.root().join(".gitattributes")).unwrap_or_default();
    let patterns = attrs
        .lines()
        .filter(|l| l.contains("filter=lfs"))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect();
    Ok(LfsStatus {
        installed,
        patterns,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LargeFile {
    pub path: String,
    pub bytes: u64,
}

/// Staged files bigger than `threshold` bytes that are not stored through LFS. GitHub rejects
/// files over 100 MB, and any large blob stays in the history for good.
pub fn large_staged_files(git: &Git, threshold: u64) -> Result<Vec<LargeFile>> {
    // `:<mode> <mode> <sha> <sha> <status>\0<path>\0`
    let out = git.output([
        "diff",
        "--cached",
        "--raw",
        "--no-renames",
        "--no-abbrev",
        "-z",
        "--diff-filter=AM",
    ])?;
    let mut parts = out.split(|&b| b == 0).filter(|p| !p.is_empty());
    let mut found = Vec::new();
    while let (Some(meta), Some(path)) = (parts.next(), parts.next()) {
        let meta = String::from_utf8_lossy(meta);
        let sha = meta.split_whitespace().nth(3).unwrap_or_default();
        let Ok(oid) = validate::oid(sha) else {
            continue;
        };
        let size: u64 = git
            .output(["cat-file", "-s", oid.to_string().as_str()])
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o).trim().parse().ok())
            .unwrap_or(0);
        let path = String::from_utf8_lossy(path).into_owned();
        // An LFS pointer file is tiny, so files that are really tracked never show up here.
        if size > threshold {
            found.push(LargeFile { path, bytes: size });
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.bytes));
    Ok(found)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum LfsAction {
    /// Starts storing files matching `pattern` through LFS.
    Track { pattern: String },
}

pub fn lfs_action(git: &Git, action: &LfsAction) -> Result<()> {
    match action {
        LfsAction::Track { pattern } => {
            let p = pattern.trim();
            let ok = !p.is_empty()
                && p.len() <= 200
                && !p.starts_with('-')
                && !p.chars().any(|c| c.is_control() || c == '"');
            if !ok {
                return Err(AppError::Git("invalid pattern".into()));
            }
            git.output(["lfs", "track", "--", p])?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    #[test]
    fn submodule_status_lines_are_parsed() {
        let text = format!(
            " {a} libs/clean (v1.2.0)\n-{b} libs/missing\n+{c} libs/moved (heads/main)\nU{d} libs/conflict\n",
            a = "a".repeat(40),
            b = "b".repeat(40),
            c = "c".repeat(40),
            d = "d".repeat(40),
        );
        let s = parse_submodules(&text);
        assert_eq!(s.len(), 4);
        assert_eq!(
            (s[0].path.as_str(), s[0].state, s[0].describe.as_deref()),
            ("libs/clean", SubmoduleState::Clean, Some("v1.2.0"))
        );
        assert_eq!(
            (s[1].path.as_str(), s[1].state),
            ("libs/missing", SubmoduleState::Uninitialized)
        );
        assert_eq!(s[2].state, SubmoduleState::Modified);
        assert_eq!(s[3].state, SubmoduleState::Conflicted);
        assert!(parse_submodules("garbage\n\n").is_empty());
    }

    /// A repo with one commit, usable as a submodule source.
    fn source() -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        commit_file(&git, "lib.txt", "lib\n", "lib");
        (d, git)
    }

    #[test]
    fn a_real_submodule_is_listed_and_updated() {
        let (src_dir, _src) = source();
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        // `file` transport is blocked by default for submodules; allow it for this test only.
        git.output([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            src_dir.path().to_str().unwrap(),
            "libs/lib",
        ])
        .unwrap();
        git.output(["commit", "-q", "-m", "add submodule"]).unwrap();

        let listed = list_submodules(&git).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].path.as_str(), listed[0].state),
            ("libs/lib", SubmoduleState::Clean)
        );

        // Remove the checked-out copy, as a fresh clone would lack it, then bring it back.
        std::fs::remove_dir_all(git.root().join("libs/lib")).unwrap();
        std::fs::create_dir(git.root().join("libs/lib")).unwrap();
        git.output(["submodule", "deinit", "-f", "libs/lib"])
            .unwrap();
        assert_eq!(
            list_submodules(&git).unwrap()[0].state,
            SubmoduleState::Uninitialized
        );
        git.clone()
            .with_overrides(crate::git::cli::GitOverrides {
                config: vec![("protocol.file.allow".into(), "always".into())],
                env: vec![],
            })
            .output(["submodule", "update", "--init", "--", "libs/lib"])
            .unwrap();
        assert_eq!(
            list_submodules(&git).unwrap()[0].state,
            SubmoduleState::Clean
        );
        assert!(update_submodules(&git, Some("../x")).is_err());
    }

    #[test]
    fn a_submodule_can_be_added_from_a_folder_or_url() {
        let (src_dir, _src) = source();
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");

        add_submodule(&git, src_dir.path().to_str().unwrap(), "libs/lib/").unwrap();
        let listed = list_submodules(&git).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "libs/lib");
        assert!(git.root().join("libs/lib/lib.txt").exists(), "cloned");
        let staged =
            String::from_utf8_lossy(&git.output(["diff", "--cached", "--name-only"]).unwrap())
                .lines()
                .map(str::to_string)
                .collect::<Vec<_>>();
        assert_eq!(staged, [".gitmodules", "libs/lib"], "staged, not committed");

        // Adding on top of an existing path is git's error, passed on.
        assert!(add_submodule(&git, src_dir.path().to_str().unwrap(), "libs/lib").is_err());
    }

    #[test]
    fn hostile_submodule_input_is_refused() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        for (url, path) in [
            ("--upload-pack=touch /tmp/x", "libs/a"),
            ("ext::sh -c touch% /tmp/x", "libs/a"),
            ("https://example.com/r.git", "../escape"),
            ("https://example.com/r.git", "/abs/path"),
            ("https://example.com/r.git", ""),
            ("", "libs/a"),
        ] {
            assert!(add_submodule(&git, url, path).is_err(), "{url:?} {path:?}");
        }
        assert!(list_submodules(&git).unwrap().is_empty());
        assert!(!git.root().join(".gitmodules").exists());
    }

    #[test]
    fn worktrees_are_listed_added_and_removed() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "base");
        let before = list_worktrees(&git).unwrap();
        assert_eq!(before.len(), 1);
        assert!(before[0].is_main);
        assert_eq!(before[0].branch.as_deref(), Some("main"));

        let holder = tempfile::tempdir().unwrap();
        let dir = holder.path().join("feature-wt");
        add_worktree(&git, &dir, "feature", true).unwrap();
        let after = list_worktrees(&git).unwrap();
        assert_eq!(after.len(), 2);
        let linked = after.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(linked.branch.as_deref(), Some("feature"));
        assert!(dir.join("a.txt").exists());

        // The main working directory is protected; the linked one can go.
        assert!(remove_worktree(&git, &after[0].path).is_err());
        assert!(remove_worktree(&git, "/not/a/worktree").is_err());
        remove_worktree(&git, &linked.path).unwrap();
        assert_eq!(list_worktrees(&git).unwrap().len(), 1);

        assert!(add_worktree(&git, &holder.path().join("x"), "--evil", true).is_err());
    }

    #[test]
    fn lfs_patterns_come_from_gitattributes_and_hostile_patterns_are_refused() {
        let (_d, git) = init_repo();
        assert!(lfs_status(&git).unwrap().patterns.is_empty());
        write(
            &git,
            ".gitattributes",
            "*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\nassets/** filter=lfs -text\n",
        );
        let s = lfs_status(&git).unwrap();
        assert_eq!(s.patterns, ["*.psd", "assets/**"]);
        for bad in ["", "--all", "a\"b", "a\nb"] {
            assert!(
                lfs_action(
                    &git,
                    &LfsAction::Track {
                        pattern: bad.into()
                    }
                )
                .is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn large_staged_files_are_reported_largest_first() {
        let (_d, git) = init_repo();
        write(&git, "small.txt", "tiny\n");
        write(&git, "big.bin", &"x".repeat(20_000));
        write(&git, "medium.bin", &"y".repeat(5_000));
        git.output(["add", "-A"]).unwrap();
        let found = large_staged_files(&git, 4_000).unwrap();
        assert_eq!(
            found.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["big.bin", "medium.bin"]
        );
        assert_eq!(found[0].bytes, 20_000);
        assert!(large_staged_files(&git, 1_000_000).unwrap().is_empty());
    }
}
