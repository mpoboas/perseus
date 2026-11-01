//! Keeping OAuth access tokens fresh from inside the credential helper.
//!
//! Git can run several helper processes at once (fetching many remotes, the app and a
//! terminal at the same time). Providers such as GitLab rotate the refresh token on
//! every use, so two racing refreshes would invalidate each other and log the user
//! out. A per-credential file lock serialises them, and the credential is re-read
//! after the lock is taken so that only the first process actually refreshes.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::http::Http;
use crate::oauth::{self, OAuthError};
use crate::store::{Credential, OAuthState, SecretStore, StoreError};
use crate::validate;

/// Refresh slightly early so a token does not expire mid-request.
const SKEW_SECS: u64 = 60;

/// Everything needed to refresh: where to talk, where to lock, and what time it is.
pub struct Refresher<'a> {
    pub http: &'a dyn Http,
    pub lock_dir: PathBuf,
    pub now: u64,
}

/// The credential to hand to git, plus a note if refreshing failed.
pub struct Fresh {
    pub credential: Option<Credential>,
    /// Set when the token was due for renewal but renewal failed. The stale token is
    /// still returned: the server decides, and the user sees why via this message.
    pub warning: Option<String>,
}

pub fn needs_refresh(c: &Credential, now: u64) -> bool {
    matches!(
        &c.oauth,
        Some(OAuthState {
            refresh_token: Some(_),
            expires_at: Some(exp),
            ..
        }) if *exp <= now.saturating_add(SKEW_SECS)
    )
}

/// A directory for lock files that other users cannot pre-create entries in.
pub fn default_lock_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(std::env::temp_dir)
        .join("perseus-locks")
}

fn lock(dir: &Path, profile: &str, host: &str) -> std::io::Result<File> {
    std::fs::create_dir_all(dir)?;
    // Both parts are validated to a tiny safe alphabet; ':' is not allowed in Windows names.
    let name = format!("refresh-{profile}-{}.lock", host.replace(':', "_"));
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(name))?;
    file.lock()?; // blocks until the other process finishes; released when dropped
    Ok(file)
}

/// Looks up the credential and renews it first if it is (about to be) expired.
pub fn fresh_credential(
    store: &dyn SecretStore,
    r: &Refresher<'_>,
    profile: &str,
    host: &str,
) -> Result<Fresh, StoreError> {
    let Some(first) = store.get(profile, host)? else {
        return Ok(Fresh {
            credential: None,
            warning: None,
        });
    };
    if !needs_refresh(&first, r.now) {
        return Ok(Fresh {
            credential: Some(first),
            warning: None,
        });
    }
    if !validate::is_profile_id(profile) || validate::host(host).is_none() {
        return Err(StoreError::Invalid("credential key"));
    }

    let _guard = lock(&r.lock_dir, profile, host)
        .map_err(|e| StoreError::Backend(format!("could not take refresh lock: {e}")))?;

    // Another process may have refreshed while we waited for the lock.
    let Some(current) = store.get(profile, host)? else {
        return Ok(Fresh {
            credential: None,
            warning: None,
        });
    };
    if !needs_refresh(&current, r.now) {
        return Ok(Fresh {
            credential: Some(current),
            warning: None,
        });
    }

    let oauth = current.oauth.clone().expect("needs_refresh implies oauth");
    let refresh_token = oauth
        .refresh_token
        .clone()
        .expect("needs_refresh implies refresh token");
    match oauth::refresh(r.http, &oauth.token_url, &oauth.client_id, &refresh_token) {
        Ok(tokens) => {
            let renewed = Credential {
                username: current.username.clone(),
                token: tokens.access_token,
                oauth: Some(OAuthState {
                    // Providers that rotate send a new one; otherwise the old one stays valid.
                    refresh_token: tokens.refresh_token.or(Some(refresh_token)),
                    expires_at: tokens.expires_in.map(|s| r.now.saturating_add(s)),
                    ..oauth
                }),
            };
            store.set(profile, host, &renewed)?;
            Ok(Fresh {
                credential: Some(renewed),
                warning: None,
            })
        }
        Err(e @ OAuthError::ReauthRequired) => Ok(Fresh {
            credential: Some(current),
            warning: Some(format!("{e} (open Perseus > Profiles to sign in again)")),
        }),
        Err(e) => Ok(Fresh {
            credential: Some(current),
            warning: Some(format!("token refresh failed: {e}")),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::oauth::testutil::FakeHttp;
    use crate::store::MemoryStore;

    const P: &str = "0123456789abcdef0123456789abcdef";
    const URL: &str = "https://gitlab.com/oauth/token";

    fn oauth_cred(token: &str, refresh: &str, expires_at: Option<u64>) -> Credential {
        Credential {
            username: "oauth2".into(),
            token: token.into(),
            oauth: Some(OAuthState {
                token_url: URL.into(),
                client_id: "cid".into(),
                refresh_token: Some(refresh.into()),
                expires_at,
            }),
        }
    }

    fn refresher<'a>(http: &'a dyn Http, dir: &Path, now: u64) -> Refresher<'a> {
        Refresher {
            http,
            lock_dir: dir.to_path_buf(),
            now,
        }
    }

    #[test]
    fn needs_refresh_rules() {
        let now = 10_000;
        assert!(needs_refresh(&oauth_cred("t", "r", Some(now - 1)), now));
        assert!(needs_refresh(&oauth_cred("t", "r", Some(now + 30)), now)); // inside the skew
        assert!(!needs_refresh(&oauth_cred("t", "r", Some(now + 3600)), now));
        assert!(!needs_refresh(&oauth_cred("t", "r", None), now)); // never expires
        assert!(!needs_refresh(&Credential::new("u", "pat"), now)); // pasted token
        let mut no_refresh = oauth_cred("t", "r", Some(0));
        no_refresh.oauth.as_mut().unwrap().refresh_token = None;
        assert!(!needs_refresh(&no_refresh, now));
    }

    #[test]
    fn valid_tokens_are_returned_without_any_network_call() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        store
            .set(P, "gitlab.com", &oauth_cred("good", "r", Some(99_999)))
            .unwrap();
        let http = FakeHttp::default(); // would panic on any request

        let f = fresh_credential(
            &store,
            &refresher(&http, dir.path(), 1_000),
            P,
            "gitlab.com",
        )
        .unwrap();
        assert_eq!(f.credential.unwrap().token, "good");
        assert!(f.warning.is_none());
        assert_eq!(http.count(), 0);
    }

    #[test]
    fn expired_tokens_are_renewed_and_persisted_with_the_rotated_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        store
            .set(P, "gitlab.com", &oauth_cred("old", "r1", Some(500)))
            .unwrap();
        let http = FakeHttp::default().json(
            200,
            r#"{"access_token":"new","refresh_token":"r2","expires_in":7200}"#,
        );

        let f = fresh_credential(
            &store,
            &refresher(&http, dir.path(), 1_000),
            P,
            "gitlab.com",
        )
        .unwrap();
        let c = f.credential.unwrap();
        assert_eq!(c.token, "new");
        assert!(f.warning.is_none());

        let stored = store.get(P, "gitlab.com").unwrap().unwrap();
        let o = stored.oauth.unwrap();
        assert_eq!(stored.token, "new");
        assert_eq!(o.refresh_token.as_deref(), Some("r2"));
        assert_eq!(o.expires_at, Some(8_200));
        // Identity fields survive the refresh.
        assert_eq!((o.client_id.as_str(), o.token_url.as_str()), ("cid", URL));
    }

    #[test]
    fn a_provider_that_does_not_rotate_keeps_the_old_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        store
            .set(P, "gitlab.com", &oauth_cred("old", "keep-me", Some(1)))
            .unwrap();
        let http = FakeHttp::default().json(200, r#"{"access_token":"new","expires_in":60}"#);

        fresh_credential(
            &store,
            &refresher(&http, dir.path(), 1_000),
            P,
            "gitlab.com",
        )
        .unwrap();
        let o = store.get(P, "gitlab.com").unwrap().unwrap().oauth.unwrap();
        assert_eq!(o.refresh_token.as_deref(), Some("keep-me"));
    }

    #[test]
    fn failed_refresh_still_returns_the_stale_token_with_a_warning() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        store
            .set(P, "gitlab.com", &oauth_cred("stale", "r", Some(1)))
            .unwrap();

        let revoked = FakeHttp::default().json(400, r#"{"error":"invalid_grant"}"#);
        let f = fresh_credential(
            &store,
            &refresher(&revoked, dir.path(), 1_000),
            P,
            "gitlab.com",
        )
        .unwrap();
        assert_eq!(f.credential.unwrap().token, "stale");
        assert!(f.warning.unwrap().contains("sign in again"));

        let offline = FakeHttp::default().fail("connection refused");
        let f = fresh_credential(
            &store,
            &refresher(&offline, dir.path(), 1_000),
            P,
            "gitlab.com",
        )
        .unwrap();
        assert!(f.warning.unwrap().contains("refresh failed"));
        // Nothing was overwritten by the failures.
        assert_eq!(store.get(P, "gitlab.com").unwrap().unwrap().token, "stale");
    }

    #[test]
    fn missing_credentials_are_just_absent() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let http = FakeHttp::default();
        let f =
            fresh_credential(&store, &refresher(&http, dir.path(), 1), P, "gitlab.com").unwrap();
        assert!(f.credential.is_none() && f.warning.is_none());
    }

    /// Many helpers racing on one expired token must refresh exactly once; the rest
    /// pick up the result. Without the lock, rotating refresh tokens would break.
    #[test]
    fn concurrent_helpers_refresh_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryStore::default());
        store
            .set(P, "gitlab.com", &oauth_cred("old", "r1", Some(1)))
            .unwrap();
        // One response only: a second refresh attempt would panic the fake.
        let http = Arc::new(FakeHttp::default().json(
            200,
            r#"{"access_token":"new","refresh_token":"r2","expires_in":7200}"#,
        ));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (store, http, dir) = (store.clone(), http.clone(), dir.path().to_path_buf());
                std::thread::spawn(move || {
                    let r = Refresher {
                        http: &*http,
                        lock_dir: dir,
                        now: 1_000,
                    };
                    fresh_credential(&*store, &r, P, "gitlab.com")
                        .unwrap()
                        .credential
                        .unwrap()
                        .token
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), "new");
        }
        assert_eq!(http.count(), 1, "refresh token was spent more than once");
    }
}
