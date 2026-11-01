//! File lists and unified patches. Patches are produced by `git` (rename detection,
//! binary handling and hunk formatting are not worth reimplementing) with every
//! repo-configurable program hook disabled: `--no-ext-diff` and `--no-textconv`
//! stop a hostile `diff.external` / `textconv` setting from running code just
//! because the user clicked a file.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

/// Patches larger than this are cut off (the UI shows a "truncated" notice).
pub const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub orig_path: Option<String>,
    /// `A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied, `T`ype changed.
    pub status: char,
}

/// Parses `--name-status -z` output: `S\0path\0` or `R100\0old\0new\0`.
pub fn parse_name_status(raw: &[u8]) -> Result<Vec<FileChange>> {
    let text = String::from_utf8_lossy(raw);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut out = Vec::new();
    while let Some(code) = tokens.next() {
        let status = code.chars().next().unwrap_or('?');
        let bad = || AppError::Git(format!("unexpected diff output near {code:?}"));
        if matches!(status, 'R' | 'C') {
            let old = tokens.next().ok_or_else(bad)?;
            let new = tokens.next().ok_or_else(bad)?;
            out.push(FileChange {
                path: new.to_string(),
                orig_path: Some(old.to_string()),
                status,
            });
        } else {
            let path = tokens.next().ok_or_else(bad)?;
            out.push(FileChange {
                path: path.to_string(),
                orig_path: None,
                status,
            });
        }
    }
    Ok(out)
}

/// Files changed by a commit, relative to its first parent (or to nothing for a root commit).
pub fn commit_files(git: &Git, oid: &str) -> Result<Vec<FileChange>> {
    let oid = validate::oid(oid)?.to_string();
    let raw = git.output([
        "show",
        "--format=",
        "--diff-merges=first-parent",
        "--name-status",
        "-M",
        "-z",
        "--no-ext-diff",
        oid.as_str(),
    ])?;
    parse_name_status(&raw)
}

const PATCH_FLAGS: [&str; 3] = ["--no-ext-diff", "--no-textconv", "--no-color"];

/// For renames, listing the old path too lets git pair the two sides.
fn pathspecs<'a>(path: &'a str, orig: Option<&'a str>) -> Result<Vec<&'a str>> {
    let mut v = vec!["--", validate::rel_path(path)?];
    if let Some(o) = orig {
        v.push(validate::rel_path(o)?);
    }
    Ok(v)
}

/// Patch for one file of a commit.
pub fn commit_patch(
    git: &Git,
    oid: &str,
    path: &str,
    orig_path: Option<&str>,
) -> Result<(Vec<u8>, bool)> {
    let oid = validate::oid(oid)?.to_string();
    let mut args = vec![
        "show",
        "--format=",
        "--diff-merges=first-parent",
        "-M",
        "--patch",
    ];
    args.extend(PATCH_FLAGS);
    args.push(oid.as_str());
    args.extend(pathspecs(path, orig_path)?);
    git.output_capped(args, MAX_PATCH_BYTES, &[0])
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkSide {
    Unstaged,
    Staged,
    Untracked,
}

/// Patch for one file in the working tree or index.
pub fn worktree_patch(
    git: &Git,
    side: WorkSide,
    path: &str,
    orig_path: Option<&str>,
) -> Result<(Vec<u8>, bool)> {
    let mut args: Vec<&str> = vec!["diff"];
    args.extend(PATCH_FLAGS);
    let ok: &[i32] = match side {
        WorkSide::Unstaged => {
            args.extend(pathspecs(path, None)?);
            &[0]
        }
        WorkSide::Staged => {
            args.extend(["--cached", "-M"]);
            args.extend(pathspecs(path, orig_path)?);
            &[0]
        }
        WorkSide::Untracked => {
            // Diffing against /dev/null renders a new file as all-additions; exit 1 means "differs".
            args.extend(["--no-index", "--", "/dev/null", validate::rel_path(path)?]);
            &[0, 1]
        }
    };
    git.output_capped(args, MAX_PATCH_BYTES, ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn head(git: &Git) -> String {
        String::from_utf8(git.output(["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .to_string()
    }

    fn patch_text(r: (Vec<u8>, bool)) -> String {
        String::from_utf8_lossy(&r.0).into_owned()
    }

    #[test]
    fn parses_name_status_with_renames() {
        let parsed = parse_name_status(b"M\0a.txt\0R100\0old name.txt\0new.txt\0A\0z\0").unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[1].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(parsed[1].path, "new.txt");
        assert!(parse_name_status(b"R100\0only-one\0").is_err());
    }

    #[test]
    fn root_normal_and_merge_commits() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "root");
        let root = head(&git);
        let files = commit_files(&git, &root).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, 'A');
        assert!(patch_text(commit_patch(&git, &root, "a.txt", None).unwrap()).contains("+a"));

        git.output(["switch", "-q", "-c", "f"]).unwrap();
        commit_file(&git, "f.txt", "f\n", "feature");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "m.txt", "m\n", "main");
        git.output(["merge", "-q", "--no-ff", "f", "-m", "merge"])
            .unwrap();

        // A merge shows what it brought in relative to the first parent.
        let files = commit_files(&git, &head(&git)).unwrap();
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["f.txt"]
        );
    }

    #[test]
    fn renames_pair_up_when_both_paths_are_given() {
        let (_d, git) = init_repo();
        commit_file(&git, "old.txt", &"content line\n".repeat(20), "add");
        git.output(["mv", "old.txt", "new name.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "rename"]).unwrap();
        let oid = head(&git);

        let files = commit_files(&git, &oid).unwrap();
        assert_eq!(files[0].status, 'R');
        let orig = files[0].orig_path.as_deref();
        let text = patch_text(commit_patch(&git, &oid, &files[0].path, orig).unwrap());
        assert!(text.contains("rename from old.txt"), "{text}");
    }

    #[test]
    fn working_tree_sides() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "a");
        write(&git, "a.txt", "two\n");
        let unstaged = patch_text(worktree_patch(&git, WorkSide::Unstaged, "a.txt", None).unwrap());
        assert!(unstaged.contains("-one") && unstaged.contains("+two"));

        git.output(["add", "a.txt"]).unwrap();
        assert!(
            patch_text(worktree_patch(&git, WorkSide::Unstaged, "a.txt", None).unwrap()).is_empty()
        );
        let staged = patch_text(worktree_patch(&git, WorkSide::Staged, "a.txt", None).unwrap());
        assert!(staged.contains("+two"));

        write(&git, "dir/new file.txt", "fresh\n");
        let untracked = patch_text(
            worktree_patch(&git, WorkSide::Untracked, "dir/new file.txt", None).unwrap(),
        );
        assert!(
            untracked.contains("new file mode") && untracked.contains("+fresh"),
            "{untracked}"
        );
    }

    #[test]
    fn huge_patches_are_truncated() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "x\n", "a");
        write(&git, "big.txt", &"y".repeat(MAX_PATCH_BYTES + 100_000));
        let (bytes, truncated) =
            worktree_patch(&git, WorkSide::Untracked, "big.txt", None).unwrap();
        assert!(truncated);
        assert_eq!(bytes.len(), MAX_PATCH_BYTES);
    }

    #[test]
    fn rejects_hostile_arguments() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        let oid = head(&git);
        assert!(commit_patch(&git, "HEAD", "a.txt", None).is_err());
        assert!(commit_patch(&git, &oid, "../secret", None).is_err());
        assert!(commit_patch(&git, &oid, "a.txt", Some("/etc/passwd")).is_err());
        assert!(commit_files(&git, "--output=x").is_err());
        assert!(worktree_patch(&git, WorkSide::Untracked, "../../etc/hosts", None).is_err());
    }

    /// Opening a diff must never run programs named in a repo's config.
    #[test]
    fn configured_external_diff_is_not_executed() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "a");
        commit_file(&git, "a.txt", "two\n", "b");
        let oid = head(&git);

        let tools = tempfile::tempdir().unwrap();
        let marker = tools.path().join("ran.marker");
        let script = tools.path().join("ext.sh");
        let fwd = |p: &std::path::Path| p.to_str().unwrap().replace('\\', "/");
        std::fs::write(&script, format!("echo ran > \"{}\"\n", fwd(&marker))).unwrap();
        git.output(["config", "diff.external", &format!("sh {}", fwd(&script))])
            .unwrap();

        // Sanity: a plain `git diff` really would run it, so the assertion below means something.
        let _ = git.output(["diff", "HEAD~1", "HEAD"]);
        assert!(marker.exists(), "test setup: external diff did not fire");
        std::fs::remove_file(&marker).unwrap();

        let text = patch_text(commit_patch(&git, &oid, "a.txt", None).unwrap());
        assert!(text.contains("+two"));
        write(&git, "a.txt", "three\n");
        worktree_patch(&git, WorkSide::Unstaged, "a.txt", None).unwrap();
        assert!(!marker.exists(), "external diff program was executed");
    }
}
