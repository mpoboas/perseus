use serde::Serialize;

use crate::error::{AppError, Result};

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
        });
    }
    out.sort_by_key(|r| r.name.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
