//! File contents for the picture view of the diff. Blobs come from `git cat-file` (never
//! `show`, which can apply filters and text conversions configured in the repository); the
//! working-tree side is read straight from disk, refusing anything that is not a plain file
//! inside the repository.

use std::io::Read;

use crate::error::Result;
use crate::git::cli::Git;
use crate::git::validate;

/// Larger files are cut off; the UI says so instead of drawing half a picture.
pub const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

/// Which version of a file to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// The file as of a commit.
    Commit(String),
    /// The file as of a commit's first parent.
    ParentOf(String),
    Head,
    Index,
    /// The file on disk.
    Work,
}

impl Source {
    pub fn parse(s: &str) -> Result<Source> {
        Ok(match s {
            "head" => Source::Head,
            "index" => Source::Index,
            "work" => Source::Work,
            _ => match s.strip_suffix('^') {
                Some(oid) => Source::ParentOf(validate::oid(oid)?.to_string()),
                None => Source::Commit(validate::oid(s)?.to_string()),
            },
        })
    }
}

/// The bytes of `path` as of `source` and whether they were cut off, or `None` when that version has no such file.
pub fn read(git: &Git, source: &Source, path: &str) -> Result<Option<(Vec<u8>, bool)>> {
    read_capped(git, source, path, MAX_BLOB_BYTES)
}

fn read_capped(
    git: &Git,
    source: &Source,
    path: &str,
    cap: usize,
) -> Result<Option<(Vec<u8>, bool)>> {
    let path = validate::rel_path(path)?;
    let spec = match source {
        Source::Work => return read_disk(git, path, cap),
        Source::Commit(oid) => format!("{oid}:{path}"),
        Source::ParentOf(oid) => format!("{oid}^:{path}"),
        Source::Head => format!("HEAD:{path}"),
        Source::Index => format!(":{path}"),
    };
    // Resolving the name first tells "no such file" apart from a real failure; `--quiet` makes
    // a missing one exit 1. (A `^{blob}` after `rev:path` would be read as part of the path.)
    let resolve = |name: &str| -> Result<String> {
        let out = git.output_allowing(["rev-parse", "--verify", "--quiet", name], &[0, 1])?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    };
    let named = resolve(&spec)?;
    // A directory resolves too, but is not a file.
    let oid = if named.is_empty() {
        named
    } else {
        resolve(&format!("{named}^{{blob}}"))?
    };
    if oid.is_empty() {
        return Ok(None);
    }
    let (bytes, truncated) = git.output_capped(["cat-file", "blob", oid.as_str()], cap, &[0])?;
    Ok(Some((bytes, truncated)))
}

fn read_disk(git: &Git, path: &str, cap: usize) -> Result<Option<(Vec<u8>, bool)>> {
    let full = git.root().join(path);
    // A symlink could point anywhere on the disk.
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    // A linked directory on the way would do the same.
    let inside = match (full.canonicalize(), git.root().canonicalize()) {
        (Ok(f), Ok(r)) => f.starts_with(r),
        _ => false,
    };
    if !inside {
        return Ok(None);
    }
    let Ok(file) = std::fs::File::open(&full) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    if file.take(cap as u64 + 1).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    let truncated = bytes.len() > cap;
    bytes.truncate(cap);
    Ok(Some((bytes, truncated)))
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

    fn text(r: Option<(Vec<u8>, bool)>) -> Option<String> {
        r.map(|(b, _)| String::from_utf8(b).unwrap())
    }

    #[test]
    fn reads_every_version_of_a_file() {
        let (_d, git) = init_repo();
        commit_file(&git, "p.png", "one", "first");
        commit_file(&git, "p.png", "two", "second");
        let tip = head(&git);
        write(&git, "p.png", "three");
        git.output(["add", "p.png"]).unwrap();
        write(&git, "p.png", "four");

        let get = |s: Source| text(read(&git, &s, "p.png").unwrap());
        assert_eq!(get(Source::Commit(tip.clone())).as_deref(), Some("two"));
        assert_eq!(get(Source::ParentOf(tip)).as_deref(), Some("one"));
        assert_eq!(get(Source::Head).as_deref(), Some("two"));
        assert_eq!(get(Source::Index).as_deref(), Some("three"));
        assert_eq!(get(Source::Work).as_deref(), Some("four"));
    }

    #[test]
    fn a_missing_version_is_none_rather_than_an_error() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.png", "x", "first");
        let tip = head(&git);
        assert!(
            read(&git, &Source::ParentOf(tip.clone()), "a.png")
                .unwrap()
                .is_none()
        );
        assert!(
            read(&git, &Source::Commit(tip), "other.png")
                .unwrap()
                .is_none()
        );
        assert!(read(&git, &Source::Work, "other.png").unwrap().is_none());
        assert!(read(&git, &Source::Index, "other.png").unwrap().is_none());
    }

    #[test]
    fn an_empty_repository_has_no_head_version() {
        let (_d, git) = init_repo();
        assert!(read(&git, &Source::Head, "a.png").unwrap().is_none());
    }

    #[test]
    fn parses_sources_and_refuses_anything_else() {
        let oid = "a".repeat(40);
        assert_eq!(Source::parse("head").unwrap(), Source::Head);
        assert_eq!(Source::parse("work").unwrap(), Source::Work);
        assert_eq!(Source::parse(&oid).unwrap(), Source::Commit(oid.clone()));
        assert_eq!(
            Source::parse(&format!("{oid}^")).unwrap(),
            Source::ParentOf(oid)
        );
        assert!(Source::parse("main").is_err());
        assert!(Source::parse("--all").is_err());
        assert!(Source::parse("HEAD~1").is_err());
    }

    #[test]
    fn refuses_paths_that_leave_the_repository() {
        let (_d, git) = init_repo();
        for p in ["../x", "/etc/passwd", "a/../../x", "C:\\x", ""] {
            assert!(read(&git, &Source::Work, p).is_err(), "{p}");
            assert!(read(&git, &Source::Head, p).is_err(), "{p}");
        }
    }

    #[test]
    fn cuts_off_big_files() {
        let (_d, git) = init_repo();
        commit_file(&git, "big.png", &"z".repeat(5000), "big");
        let (bytes, truncated) = read_capped(&git, &Source::Head, "big.png", 1000)
            .unwrap()
            .unwrap();
        assert!(truncated);
        assert_eq!(bytes.len(), 1000);
        let (bytes, truncated) = read_capped(&git, &Source::Work, "big.png", 1000)
            .unwrap()
            .unwrap();
        assert!(truncated);
        assert_eq!(bytes.len(), 1000);
        let (bytes, truncated) = read(&git, &Source::Work, "big.png").unwrap().unwrap();
        assert!(!truncated);
        assert_eq!(bytes.len(), 5000);
    }

    #[test]
    fn directories_are_not_files() {
        let (_d, git) = init_repo();
        commit_file(&git, "dir/a.png", "x", "first");
        assert!(read(&git, &Source::Work, "dir").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn will_not_follow_a_link_out_of_the_repository() {
        let (_d, git) = init_repo();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), git.root().join("link.png")).unwrap();
        assert!(read(&git, &Source::Work, "link.png").unwrap().is_none());
    }
}
