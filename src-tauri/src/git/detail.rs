use gix::ObjectId;
use serde::Serialize;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize)]
pub struct Person {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: Person,
    pub committer: Person,
    pub message: String,
}

fn person(sig: gix::actor::SignatureRef<'_>) -> Person {
    Person {
        name: sig.name.to_string(),
        email: sig.email.to_string(),
        time: sig.time().map(|t| t.seconds).unwrap_or_default(),
    }
}

/// `oid` comes from the webview, so it is parsed strictly as full hex before use.
pub fn commit_detail(repo: &gix::Repository, oid: &str) -> Result<CommitDetail> {
    let id = ObjectId::from_hex(oid.as_bytes()).map_err(|_| AppError::git("invalid commit id"))?;
    let commit = repo.find_commit(id).map_err(AppError::git)?;
    Ok(CommitDetail {
        oid: id.to_string(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        author: person(commit.author().map_err(AppError::git)?),
        committer: person(commit.committer().map_err(AppError::git)?),
        message: commit.message_raw_sloppy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_ids() {
        let dir = tempfile::tempdir().unwrap();
        gix::init(dir.path()).unwrap();
        let repo = gix::open(dir.path()).unwrap();
        for bad in [
            "",
            "zz",
            "HEAD",
            "--upload-pack=x",
            "abc123",
            &"g".repeat(40),
        ] {
            assert!(commit_detail(&repo, bad).is_err(), "{bad:?} accepted");
        }
    }
}
