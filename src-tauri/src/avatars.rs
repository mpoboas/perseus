//! Profile pictures for commit authors.
//!
//! Pictures come only from GitHub, and only for people Perseus can name without guessing:
//!
//! * a `…@users.noreply.github.com` address names the account (`ID+login@` or `login@`), and
//! * the active profile's own address, when that profile is signed in to GitHub, uses the avatar
//!   of the signed-in account.
//!
//! There is no Gravatar lookup: hashing an e-mail address and sending it to a third party would
//! reveal who a repository's contributors are. Every URL is assembled here from validated parts
//! (digits, or a GitHub login), the downloaded bytes are capped and must be an image, and the
//! webview only ever receives a `data:` URL, so the content-security policy does not need to allow
//! any remote image source.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::State;

use crate::error::Result;
use crate::ipc::commands::blocking;
use crate::profiles::ProfileStore;

const MAX_BYTES: u64 = 256 * 1024;
const NOREPLY: &str = "@users.noreply.github.com";

/// Where a picture for an e-mail address can be fetched from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `https://avatars.githubusercontent.com/u/<id>`
    GithubId(u64),
    /// `https://github.com/<login>.png`, which redirects to the account's picture.
    GithubLogin(String),
}

fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && !login.starts_with('-')
        && !login.ends_with('-')
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Understands GitHub's private addresses; anything else is not a source Perseus will use.
pub fn source_for(email: &str) -> Option<Source> {
    let email = email.trim().to_ascii_lowercase();
    let local = email.strip_suffix(NOREPLY)?;
    if let Some((id, login)) = local.split_once('+') {
        let id = id.parse::<u64>().ok().filter(|_| valid_login(login));
        return id.map(Source::GithubId);
    }
    valid_login(local).then(|| Source::GithubLogin(local.to_string()))
}

fn url_for(source: &Source) -> String {
    match source {
        Source::GithubId(id) => format!("https://avatars.githubusercontent.com/u/{id}?s=64"),
        Source::GithubLogin(login) => format!("https://github.com/{login}.png?size=64"),
    }
}

const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (small enough not to need a dependency).
fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    ureq::Agent::config_builder()
        .max_redirects(3)
        .timeout_global(Some(Duration::from_secs(8)))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent("Perseus")
        .build()
        .into()
}

/// Downloads a picture and returns it as a `data:` URL. `None` for anything that is not a small
/// image (a missing account, an error page, a huge file).
fn download(url: &str) -> Option<String> {
    let mut resp = agent().get(url).header("Accept", "image/*").call().ok()?;
    let kind = resp
        .headers()
        .get("content-type")?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        kind.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return None;
    }
    let bytes = resp
        .body_mut()
        .with_config()
        .limit(MAX_BYTES)
        .read_to_vec()
        .ok()?;
    Some(format!("data:{kind};base64,{}", base64(&bytes)))
}

/// The signed-in account's picture, looked up with the active profile's token.
fn own_picture(profiles: &ProfileStore, email: &str) -> Option<String> {
    let profile = profiles.active()?;
    if !profile.user_email.trim().eq_ignore_ascii_case(email.trim()) {
        return None;
    }
    let token = profiles.fresh_token("github.com").ok().flatten()?;
    let mut resp = agent()
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .call()
        .ok()?;
    let body = resp
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_string()
        .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let url = json.get("avatar_url")?.as_str()?;
    // Only GitHub's own picture host, whatever the response says.
    let rest = url.strip_prefix("https://avatars.githubusercontent.com/")?;
    if rest.contains(['\\', '@', ' ']) {
        return None;
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    download(&format!("{url}{sep}s=64"))
}

type Cache = Mutex<HashMap<String, Option<String>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A `data:` URL with the author's picture, or `None` when there is none to show. Answers are
/// remembered for the life of the app.
#[tauri::command]
pub async fn author_avatar(
    profiles: State<'_, ProfileStore>,
    email: String,
) -> Result<Option<String>> {
    let key = email.trim().to_ascii_lowercase();
    if key.is_empty() || key.len() > 254 {
        return Ok(None);
    }
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let profiles = profiles.inner().clone();
    let lookup = key.clone();
    let found = blocking(move || {
        Ok(match source_for(&lookup) {
            Some(source) => download(&url_for(&source)),
            None => own_picture(&profiles, &lookup),
        })
    })
    .await?;
    if let Ok(mut c) = cache().lock() {
        c.insert(key, found.clone());
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_private_addresses_name_the_account() {
        assert_eq!(
            source_for("128170854+mpoboas@users.noreply.github.com"),
            Some(Source::GithubId(128170854))
        );
        assert_eq!(
            source_for("Octocat@users.noreply.github.com"),
            Some(Source::GithubLogin("octocat".into()))
        );
    }

    #[test]
    fn anything_else_is_not_looked_up() {
        for e in [
            "me@example.com",
            "x+y@users.noreply.gitlab.com",
            "../evil@users.noreply.github.com",
            "1+a b@users.noreply.github.com",
            "abc+login@users.noreply.github.com",
            "-bad@users.noreply.github.com",
            "@users.noreply.github.com",
        ] {
            assert_eq!(source_for(e), None, "{e}");
        }
    }

    #[test]
    fn urls_only_point_at_github() {
        assert_eq!(
            url_for(&Source::GithubId(7)),
            "https://avatars.githubusercontent.com/u/7?s=64"
        );
        assert_eq!(
            url_for(&Source::GithubLogin("a-b".into())),
            "https://github.com/a-b.png?size=64"
        );
    }

    #[test]
    fn base64_matches_the_standard_encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
