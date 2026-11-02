//! Validation for every string that originates in the webview and ends up as a
//! git argument. Arguments are always passed as a vector (never through a shell),
//! so this is defence in depth against option injection (`--upload-pack=...`),
//! pathspec magic and path traversal.

use std::path::{Component, Path};

use gix::ObjectId;

use crate::error::{AppError, Result};

fn invalid(what: &str) -> AppError {
    AppError::Git(format!("invalid {what}"))
}

/// Branch, tag, remote or revision name. Rejects anything git itself would reject
/// plus a leading `-` (option injection).
pub fn ref_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(invalid("ref name"));
    }
    gix::validate::reference::name_partial(name.as_bytes().into())
        .map_err(|_| invalid("ref name"))?;
    Ok(name)
}

/// Remote names are config keys, so they are stricter than ref names.
pub fn remote_name(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(name)
    } else {
        Err(invalid("remote name"))
    }
}

/// A remote URL: https/http/ssh/git/file URLs, scp-style `user@host:path`, or a local path.
/// Rejects a leading `-` (option injection), control characters, and transport helpers such as
/// `ext::<command>` or `fd::<n>`, which make git run arbitrary programs.
pub fn remote_url(url: &str) -> Result<&str> {
    let helper = url.split_once("::").is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+'))
    });
    let bad = url.trim() != url
        || url.is_empty()
        || url.len() > 2048
        || url.starts_with('-')
        || url.chars().any(char::is_control);
    if bad || helper {
        Err(invalid("remote URL"))
    } else {
        Ok(url)
    }
}

/// Full-length hex object id.
pub fn oid(s: &str) -> Result<ObjectId> {
    ObjectId::from_hex(s.as_bytes()).map_err(|_| invalid("commit id"))
}

/// A path relative to the repository root, without traversal.
pub fn rel_path(path: &str) -> Result<&str> {
    let p = Path::new(path);
    let ok = !path.is_empty()
        && !path.contains('\0')
        && !p.is_absolute()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        // Windows drive prefix (`C:\x`), rejected on every platform for consistency.
        && path.as_bytes().get(1) != Some(&b':')
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if ok { Ok(path) } else { Err(invalid("path")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names() {
        for good in ["main", "feature/x", "origin/main", "v1.0", "a-b_c"] {
            assert!(ref_name(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "-x",
            "--upload-pack=evil",
            "a..b",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "x.lock",
            "@{u}",
            "a\0b",
            "/a",
            "a//b",
            "a/",
        ] {
            assert!(ref_name(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn remote_names() {
        assert!(remote_name("origin").is_ok());
        assert!(remote_name("my-fork.2").is_ok());
        for bad in ["", "-o", "a b", "a/b", "http://x", "a;b"] {
            assert!(remote_name(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn remote_urls() {
        for good in [
            "https://github.com/a/b.git",
            "ssh://git@host:2222/a/b.git",
            "git@github.com:a/b.git",
            "file:///srv/repo.git",
            "C:\\Users\\me\\My Repos\\x.git",
            "/srv/git/x.git",
            "../sibling.git",
        ] {
            assert!(remote_url(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "-oProxyCommand=evil",
            "--upload-pack=evil",
            "ext::sh -c touch /tmp/pwned",
            "fd::17",
            "foo::bar",
            " https://x/y",
            "https://x/y\n",
            "https://x/\u{0}y",
        ] {
            assert!(remote_url(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn oids() {
        assert!(oid(&"a".repeat(40)).is_ok());
        for bad in ["", "HEAD", "abc", "--all", &"g".repeat(40), &"a".repeat(41)] {
            assert!(oid(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn rel_paths() {
        for good in [
            "a.txt",
            "dir/a.txt",
            "sp ace/é.txt",
            "./a",
            "-leading-dash.txt",
        ] {
            assert!(rel_path(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "../x",
            "a/../../x",
            "/etc/passwd",
            "\\windows",
            "C:\\x",
            "a\0b",
        ] {
            assert!(rel_path(bad).is_err(), "{bad:?} accepted");
        }
    }
}
