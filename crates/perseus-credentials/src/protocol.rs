//! The git credential-helper protocol, as served by Perseus.
//!
//! Git runs `helper get|store|erase`, writes `key=value` lines on stdin ending with
//! a blank line, and (for `get`) reads `key=value` lines back. This implementation:
//!
//! * reads the whole request strictly: bounded size, no control characters, UTF-8 only
//! * answers `get` only for the profile named by the caller, for `https` hosts (or
//!   `http` on loopback), from the OS keychain
//! * treats `store` and `erase` as no-ops: tokens are managed in the Perseus UI,
//!   never written by whatever URL a repository happens to use

use std::fmt;
use std::io::{BufRead, Read, Write};

use crate::refresh::{Fresh, Refresher, fresh_credential};
use crate::store::{SecretStore, StoreError};
use crate::validate;

const MAX_LINES: usize = 64;
const MAX_LINE_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Get,
    Store,
    Erase,
}

impl Op {
    pub fn parse(s: &str) -> Option<Op> {
        match s {
            "get" => Some(Op::Get),
            "store" => Some(Op::Store),
            "erase" => Some(Op::Erase),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    Malformed(&'static str),
    Store(StoreError),
    Io,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::Malformed(why) => write!(f, "malformed credential request: {why}"),
            ProtocolError::Store(e) => write!(f, "{e}"),
            ProtocolError::Io => write!(f, "i/o error"),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Default)]
struct Request {
    protocol: Option<String>,
    host: Option<String>,
}

fn read_request(mut input: impl BufRead) -> Result<Request, ProtocolError> {
    let mut req = Request::default();
    let mut line = Vec::new();
    for _ in 0..=MAX_LINES {
        line.clear();
        let n = input
            .by_ref()
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| ProtocolError::Io)?;
        if n == 0 {
            return Ok(req); // EOF without a blank line is tolerated
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        } else if line.len() > MAX_LINE_BYTES {
            return Err(ProtocolError::Malformed("line too long"));
        }
        if line.is_empty() {
            return Ok(req);
        }
        // Rejects NUL, CR and every other control byte; a CR in a value is how
        // injected lines slip past naive parsers.
        if line.iter().any(|&b| b < 0x20 || b == 0x7f) {
            return Err(ProtocolError::Malformed("control character"));
        }
        let text = std::str::from_utf8(&line).map_err(|_| ProtocolError::Malformed("not utf-8"))?;
        let (key, value) = text
            .split_once('=')
            .ok_or(ProtocolError::Malformed("line without '='"))?;
        match key {
            "protocol" => req.protocol = Some(value.to_string()),
            "host" => req.host = Some(value.to_string()),
            _ => {}
        }
    }
    Err(ProtocolError::Malformed("too many lines"))
}

/// Handles one helper invocation. Errors are for malformed input or an unavailable
/// store; "no credential" is a successful run with empty output.
///
/// With a `refresher`, OAuth tokens that are (nearly) expired are renewed first.
/// The returned string, if any, is a warning for the user (for example "sign in
/// again"); it never contains a secret.
pub fn run(
    op: Op,
    input: impl BufRead,
    mut out: impl Write,
    profile: Option<&str>,
    store: &dyn SecretStore,
    refresher: Option<&Refresher<'_>>,
) -> Result<Option<String>, ProtocolError> {
    let req = read_request(input)?;
    if op != Op::Get {
        return Ok(None);
    }
    let Some(profile) = profile.filter(|p| validate::is_profile_id(p)) else {
        return Ok(None);
    };
    let (Some(protocol), Some(host)) = (req.protocol, req.host.as_deref().and_then(validate::host))
    else {
        return Ok(None);
    };
    let scheme_ok = protocol == "https" || (protocol == "http" && validate::is_loopback(&host));
    if !scheme_ok {
        return Ok(None);
    }

    let fresh = match refresher {
        Some(r) => fresh_credential(store, r, profile, &host).map_err(ProtocolError::Store)?,
        None => Fresh {
            credential: store.get(profile, &host).map_err(ProtocolError::Store)?,
            warning: None,
        },
    };
    if let Some(c) = fresh.credential
        // Re-checked on the way out: never emit a value that could add protocol lines.
        && validate::is_plain_text(&c.username)
        && validate::is_plain_text(&c.token)
    {
        write!(out, "username={}\npassword={}\n", c.username, c.token)
            .map_err(|_| ProtocolError::Io)?;
    }
    Ok(fresh.warning)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Credential, MemoryStore};

    const P: &str = "0123456789abcdef0123456789abcdef";

    fn store_with(host: &str) -> MemoryStore {
        let s = MemoryStore::default();
        s.set(P, host, &Credential::new("ada", "ghp_secret"))
            .unwrap();
        s
    }

    fn get(
        input: &str,
        profile: Option<&str>,
        store: &dyn SecretStore,
    ) -> Result<String, ProtocolError> {
        let mut out = Vec::new();
        run(Op::Get, input.as_bytes(), &mut out, profile, store, None)?;
        Ok(String::from_utf8(out).unwrap())
    }

    #[test]
    fn answers_get_for_the_profiles_host() {
        let s = store_with("github.com");
        let req = "protocol=https\nhost=GitHub.com\npath=ada/repo.git\n\n";
        assert_eq!(
            get(req, Some(P), &s).unwrap(),
            "username=ada\npassword=ghp_secret\n"
        );
    }

    #[test]
    fn silent_when_there_is_nothing_to_give() {
        let s = store_with("github.com");
        let https = |host: &str| format!("protocol=https\nhost={host}\n\n");
        // Other host, other profile, no profile, invalid profile.
        assert_eq!(get(&https("gitlab.com"), Some(P), &s).unwrap(), "");
        assert_eq!(
            get(&https("github.com"), Some(&"f".repeat(32)), &s).unwrap(),
            ""
        );
        assert_eq!(get(&https("github.com"), None, &s).unwrap(), "");
        assert_eq!(get(&https("github.com"), Some("../etc"), &s).unwrap(), "");
        // Missing or unusable fields.
        assert_eq!(get("protocol=https\n\n", Some(P), &s).unwrap(), "");
        assert_eq!(get(&https("not a host"), Some(P), &s).unwrap(), "");
    }

    #[test]
    fn only_https_or_loopback_http_gets_tokens() {
        let s = store_with("github.com");
        let lo = store_with("127.0.0.1:8080");
        assert_eq!(
            get("protocol=http\nhost=github.com\n\n", Some(P), &s).unwrap(),
            ""
        );
        assert_eq!(
            get("protocol=ssh\nhost=github.com\n\n", Some(P), &s).unwrap(),
            ""
        );
        assert!(
            get("protocol=http\nhost=127.0.0.1:8080\n\n", Some(P), &lo)
                .unwrap()
                .contains("password=ghp_secret")
        );
    }

    #[test]
    fn store_and_erase_never_change_anything() {
        let s = store_with("github.com");
        for op in [Op::Store, Op::Erase] {
            let mut out = Vec::new();
            let req = "protocol=https\nhost=github.com\nusername=eve\npassword=new\n\n";
            run(op, req.as_bytes(), &mut out, Some(P), &s, None).unwrap();
            assert!(out.is_empty());
        }
        let kept = s.get(P, "github.com").unwrap().unwrap();
        assert_eq!(kept.token, "ghp_secret");
    }

    #[test]
    fn malformed_requests_are_rejected_not_interpreted() {
        let s = store_with("github.com");
        let bad = [
            "protocol=https\nhost=github.com\r\n\n",      // CR
            "protocol=https\nhost=github.com\0evil\n\n",  // NUL
            "protocol=https\nhost=github.com\x1b[0m\n\n", // escape
            "just some text\n\n",                         // no '='
        ];
        for req in bad {
            let mut out = Vec::new();
            let res = run(Op::Get, req.as_bytes(), &mut out, Some(P), &s, None);
            assert!(matches!(res, Err(ProtocolError::Malformed(_))), "{req:?}");
            assert!(out.is_empty());
        }

        let mut out = Vec::new();
        let not_utf8: &[u8] = b"protocol=https\nhost=\xff\xfe\n\n";
        let res = run(Op::Get, not_utf8, &mut out, Some(P), &s, None);
        assert_eq!(res, Err(ProtocolError::Malformed("not utf-8")));

        let long = format!(
            "protocol=https\nhost={}\n\n",
            "a".repeat(MAX_LINE_BYTES + 10)
        );
        assert!(matches!(
            get(&long, Some(P), &s),
            Err(ProtocolError::Malformed("line too long"))
        ));

        let many = "k=v\n".repeat(MAX_LINES + 5);
        assert!(matches!(
            get(&many, Some(P), &s),
            Err(ProtocolError::Malformed("too many lines"))
        ));
    }

    #[test]
    fn a_hostile_stored_value_cannot_inject_lines() {
        // A store that bypasses `set` validation, as a corrupted keychain entry would.
        struct Evil;
        impl SecretStore for Evil {
            fn get(&self, _: &str, _: &str) -> Result<Option<Credential>, StoreError> {
                Ok(Some(Credential::new("ada", "t\nhost=evil.example")))
            }
            fn set(&self, _: &str, _: &str, _: &Credential) -> Result<(), StoreError> {
                Ok(())
            }
            fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
                Ok(())
            }
        }
        assert_eq!(
            get("protocol=https\nhost=github.com\n\n", Some(P), &Evil).unwrap(),
            ""
        );
    }

    #[test]
    fn store_failures_surface_as_errors() {
        struct Locked;
        impl SecretStore for Locked {
            fn get(&self, _: &str, _: &str) -> Result<Option<Credential>, StoreError> {
                Err(StoreError::Backend("locked".into()))
            }
            fn set(&self, _: &str, _: &str, _: &Credential) -> Result<(), StoreError> {
                Ok(())
            }
            fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
                Ok(())
            }
        }
        let res = get("protocol=https\nhost=github.com\n\n", Some(P), &Locked);
        assert!(matches!(res, Err(ProtocolError::Store(_))));
    }

    #[test]
    fn op_parsing() {
        assert_eq!(Op::parse("get"), Some(Op::Get));
        assert_eq!(Op::parse("GET"), None);
        assert_eq!(Op::parse("--help"), None);
    }
}
