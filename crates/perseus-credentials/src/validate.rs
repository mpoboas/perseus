//! Strict validators shared by the app and the credential helper. Anything that
//! can end up on a line of the git credential protocol must pass through here,
//! because a stray newline in a value would let it smuggle extra `key=value` lines
//! (the CVE-2020-5260 class of bug).

/// A profile id is the 32 lowercase hex characters of a UUID.
pub fn is_profile_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// True if `s` contains nothing that could break a line-oriented protocol.
pub fn is_plain_text(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(char::is_control)
}

/// Normalises a hostname (optionally `:port`) to lowercase, or rejects it.
/// Only DNS names and dotted IPv4 addresses are accepted; that covers every
/// mainstream git host and keeps the keychain key unambiguous.
pub fn host(s: &str) -> Option<String> {
    if s.is_empty() || s.len() > 260 {
        return None;
    }
    let (name, port) = match s.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (s, None),
    };
    if let Some(p) = port
        && (p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    if name.is_empty() || name.len() > 253 {
        return None;
    }
    let labels_ok = name.split('.').all(|l| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    labels_ok.then(|| s.to_ascii_lowercase())
}

/// Loopback hosts, where plain `http` does not expose a token to the network.
pub fn is_loopback(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(n, _)| n);
    name == "localhost" || name.starts_with("127.")
}

/// An OAuth endpoint or verification page we are willing to contact or open:
/// `https` (or `http` on loopback only), a plain hostname, no embedded credentials,
/// no fragment, nothing a shell or protocol line could trip over.
pub fn endpoint_url(s: &str) -> bool {
    if !is_plain_text(s) || s.len() > 2048 || s.contains(char::is_whitespace) {
        return false;
    }
    let Ok(u) = url::Url::parse(s) else {
        return false;
    };
    let Some(h) = u.host_str() else {
        return false;
    };
    let hostport = match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_string(),
    };
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && is_loopback(&hostport));
    scheme_ok
        && host(&hostport).is_some()
        && u.username().is_empty()
        && u.password().is_none()
        && u.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_urls() {
        for good in [
            "https://github.com/login/device/code",
            "https://gitlab.example.org:8443/oauth/token",
            "http://127.0.0.1:5000/token",
            "http://localhost/token",
        ] {
            assert!(endpoint_url(good), "{good}");
        }
        for bad in [
            "http://github.com/login",
            "ftp://github.com/x",
            "https://user:pw@github.com/",
            "https://github.com/#frag",
            "https://github.com/a b",
            "https://[::1]/x",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "",
            "https://github.com/\nHost: evil",
        ] {
            assert!(!endpoint_url(bad), "{bad:?} accepted");
        }
    }

    #[test]
    fn profile_ids() {
        assert!(is_profile_id(&"a1".repeat(16)));
        for bad in [
            "",
            "abc",
            &"A1".repeat(16),
            &"g1".repeat(16),
            &"a".repeat(33),
        ] {
            assert!(!is_profile_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn plain_text() {
        assert!(is_plain_text("ghp_abc123"));
        assert!(is_plain_text("név ü"));
        for bad in ["", "a\nb", "a\rb", "a\0b", "a\tb", "\x1b[0m"] {
            assert!(!is_plain_text(bad), "{bad:?}");
        }
    }

    #[test]
    fn hosts() {
        assert_eq!(host("GitHub.com").as_deref(), Some("github.com"));
        assert_eq!(
            host("git.example.org:8443").as_deref(),
            Some("git.example.org:8443")
        );
        assert_eq!(host("127.0.0.1:9000").as_deref(), Some("127.0.0.1:9000"));
        for bad in [
            "",
            "-a.com",
            "a-.com",
            "a..com",
            "a b.com",
            "a.com:",
            "a.com:99999x",
            "a.com/path",
            "user@a.com",
            "a.com\nhost=evil.com",
            "[::1]",
            "evil.com#x",
        ] {
            assert!(host(bad).is_none(), "{bad:?} accepted");
        }
    }

    #[test]
    fn loopback() {
        assert!(is_loopback("localhost:3000"));
        assert!(is_loopback("127.0.0.1"));
        assert!(!is_loopback("github.com"));
        assert!(!is_loopback("localhost.evil.com"));
    }
}
