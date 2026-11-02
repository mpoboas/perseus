//! Profile pictures for commit authors.
//!
//! Where a picture can come from, in the order Perseus tries them:
//!
//! 1. a `…@users.noreply.github.com` address names the account (`ID+login@` or `login@`);
//! 2. the active profile's own address, when that profile is signed in to GitHub, uses the
//!    signed-in account's picture;
//! 3. for a GitHub repository, GitHub's own commit record: the account GitHub has linked to the
//!    commit, which works even when the author's address is private;
//! 4. only when the user turned it on, Gravatar. That sends a hash of the address to a third party,
//!    which is why it is off by default.
//!
//! Every URL is assembled here from validated parts (digits, a GitHub login, a commit id), the
//! downloaded bytes are capped and must be an image, and the webview only ever receives a `data:`
//! URL, so the content-security policy does not need to allow any remote image source.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::State;

use crate::error::Result;
use crate::git::repo::RepoId;
use crate::hosting::{Kind, RepoRef};
use crate::ipc::channels::AppState;
use crate::ipc::commands::blocking;
use crate::ipc::hosting_commands::repo_ref;
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
    download(&checked_avatar_url(url)?)
}

/// How a lookup ended: with a picture, with "this person has none", or with a failure that may
/// pass (rate limit, offline) and so must not be remembered.
enum Lookup {
    Found(String),
    NoPicture,
    Retry,
}

fn api_agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(10)))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent("Perseus")
        .build()
        .into()
}

/// `owner/repo` with nothing that could change the URL's meaning.
fn plain_repo_path(path: &str) -> Option<(&str, &str)> {
    let (owner, repo) = path.split_once('/')?;
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (ok(owner) && ok(repo)).then_some((owner, repo))
}

/// The picture of the GitHub account linked to a commit, from GitHub's commit record.
fn commit_picture(token: Option<&str>, repo: &RepoRef, sha: &str) -> Lookup {
    let Some((owner, name)) = plain_repo_path(&repo.path) else {
        return Lookup::NoPicture;
    };
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Lookup::NoPicture;
    }
    let url = format!("https://api.github.com/repos/{owner}/{name}/commits/{sha}");
    let mut req = api_agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json");
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let Ok(mut resp) = req.call() else {
        return Lookup::Retry;
    };
    match resp.status().as_u16() {
        200 => {}
        404 | 422 => return Lookup::NoPicture,
        _ => return Lookup::Retry,
    }
    let Ok(body) = resp
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_string()
    else {
        return Lookup::Retry;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Lookup::Retry;
    };
    let Some(avatar) = json.pointer("/author/avatar_url").and_then(|v| v.as_str()) else {
        return Lookup::NoPicture;
    };
    match checked_avatar_url(avatar).and_then(|u| download(&u)) {
        Some(data) => Lookup::Found(data),
        None => Lookup::NoPicture,
    }
}

/// Only GitHub's own picture host, whatever a response says, plus a size.
fn checked_avatar_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://avatars.githubusercontent.com/")?;
    if rest.contains(['\\', '@', ' ', '#']) {
        return None;
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    Some(format!("{url}{sep}s=64"))
}

fn gravatar_url(email: &str) -> String {
    let digest = Sha256::digest(email.trim().to_ascii_lowercase().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("https://www.gravatar.com/avatar/{hex}?s=64&d=404")
}

type Cache = Mutex<HashMap<String, Option<String>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A `data:` URL with the author's picture, or `None` when there is none to show. Answers are
/// remembered for the life of the app (failures that may pass are not).
#[tauri::command]
pub async fn author_avatar(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    email: String,
    sha: String,
    gravatar: bool,
) -> Result<Option<String>> {
    let email_key = email.trim().to_ascii_lowercase();
    if email_key.is_empty() || email_key.len() > 254 {
        return Ok(None);
    }
    let key = format!("{email_key}|{gravatar}");
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let git = state.repos.git(repo_id)?;
    let profiles = profiles.inner().clone();
    let lookup_email = email_key.clone();
    let (found, remember) = blocking(move || {
        if let Some(source) = source_for(&lookup_email) {
            return Ok(match download(&url_for(&source)) {
                Some(d) => (Some(d), true),
                None => (None, false),
            });
        }
        if let Some(d) = own_picture(&profiles, &lookup_email) {
            return Ok((Some(d), true));
        }
        let mut remember = true;
        if let Some(repo) =
            repo_ref(&git)?.filter(|r| r.kind == Kind::GitHub && r.host == "github.com")
        {
            let token = profiles.fresh_token("github.com").ok().flatten();
            match commit_picture(token.as_deref(), &repo, &sha) {
                Lookup::Found(d) => return Ok((Some(d), true)),
                Lookup::NoPicture => {}
                Lookup::Retry => remember = false,
            }
        }
        if gravatar && let Some(d) = download(&gravatar_url(&lookup_email)) {
            return Ok((Some(d), true));
        }
        Ok((None, remember))
    })
    .await?;
    if remember && let Ok(mut c) = cache().lock() {
        c.insert(key, found.clone());
    }
    Ok(found)
}

/// The picture of the account that owns the repository's GitHub remote (what GitKraken shows
/// beside a branch that exists on the remote).
#[tauri::command]
pub async fn remote_avatar(state: State<'_, AppState>, repo_id: RepoId) -> Result<Option<String>> {
    let git = state.repos.git(repo_id)?;
    blocking(move || {
        let Some(repo) =
            repo_ref(&git)?.filter(|r| r.kind == Kind::GitHub && r.host == "github.com")
        else {
            return Ok(None);
        };
        let Some((owner, _)) = plain_repo_path(&repo.path) else {
            return Ok(None);
        };
        if !valid_login(owner) {
            return Ok(None);
        }
        let key = format!("owner:{}", owner.to_ascii_lowercase());
        if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
            return Ok(hit);
        }
        let found = download(&format!("https://github.com/{owner}.png?size=64"));
        if found.is_some()
            && let Ok(mut c) = cache().lock()
        {
            c.insert(key, found.clone());
        }
        Ok(found)
    })
    .await
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
    fn picture_urls_must_stay_on_githubs_picture_host() {
        assert!(
            checked_avatar_url("https://avatars.githubusercontent.com/u/1?v=4")
                .unwrap()
                .ends_with("&s=64")
        );
        for bad in [
            "https://evil.example/u/1",
            "http://avatars.githubusercontent.com/u/1",
            "https://avatars.githubusercontent.com@evil.example/u/1",
            "https://avatars.githubusercontent.com/u/1 x",
        ] {
            assert_eq!(checked_avatar_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn repository_paths_cannot_change_the_api_url() {
        assert_eq!(
            plain_repo_path("octo/hello.world"),
            Some(("octo", "hello.world"))
        );
        for bad in ["a", "a/b/c", "../x", "a/..", "a b/c", "a/b?x", ""] {
            assert_eq!(plain_repo_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn gravatar_hashes_the_trimmed_lowercase_address() {
        assert_eq!(
            gravatar_url(" Me@Example.com "),
            gravatar_url("me@example.com")
        );
        assert!(gravatar_url("a@b.c").starts_with("https://www.gravatar.com/avatar/"));
        assert!(gravatar_url("a@b.c").ends_with("?s=64&d=404"));
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
