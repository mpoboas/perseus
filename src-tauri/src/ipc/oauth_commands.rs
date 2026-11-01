//! OAuth sign-in (device flow) for GitHub and GitLab. The webview only ever sees the
//! short user code and the provider's page address; the tokens go straight from
//! the provider to the OS keychain without passing through the UI.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use perseus_credentials::http::UreqHttp;
use perseus_credentials::oauth::{Kind, Provider, now_unix, run_device_flow};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::ipc::commands::blocking;
use crate::profiles::ProfileStore;

#[derive(Default)]
pub struct OAuthFlows {
    flows: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

/// Removes the flow from the registry however the sign-in ends.
struct FlowGuard<'a> {
    flows: &'a OAuthFlows,
    id: u32,
}

impl Drop for FlowGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.flows.flows.lock() {
            m.remove(&self.id);
        }
    }
}

/// Client IDs are public identifiers (not secrets), so they may be compiled in. A
/// runtime environment variable overrides the compiled value for development.
fn configured_client_id(kind: Kind, host: &str) -> Option<String> {
    let (var, built_in, default_host) = match kind {
        Kind::GitHub => (
            "PERSEUS_GITHUB_CLIENT_ID",
            option_env!("PERSEUS_GITHUB_CLIENT_ID"),
            "github.com",
        ),
        Kind::GitLab => (
            "PERSEUS_GITLAB_CLIENT_ID",
            option_env!("PERSEUS_GITLAB_CLIENT_ID"),
            "gitlab.com",
        ),
    };
    // A built-in app is registered on the default host only; other hosts bring their own.
    if !host.eq_ignore_ascii_case(default_host) {
        return None;
    }
    std::env::var(var)
        .ok()
        .or_else(|| built_in.map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// An explicitly entered client ID wins over the configured one.
fn resolve_client_id(
    requested: Option<&str>,
    configured: Option<String>,
    host: &str,
) -> Result<String> {
    requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(configured)
        .ok_or_else(|| {
            AppError::profile(format!(
                "No OAuth client ID is configured for {host}. Register an OAuth app there and paste its client ID."
            ))
        })
}

#[derive(Serialize)]
pub struct Preset {
    kind: Kind,
    label: &'static str,
    host: &'static str,
    /// Whether this build ships a client ID for the host (the ID itself stays in Rust).
    configured: bool,
}

#[tauri::command]
pub fn oauth_presets() -> Vec<Preset> {
    [
        (Kind::GitHub, "GitHub", "github.com"),
        (Kind::GitLab, "GitLab", "gitlab.com"),
    ]
    .into_iter()
    .map(|(kind, label, host)| Preset {
        kind,
        label,
        host,
        configured: configured_client_id(kind, host).is_some(),
    })
    .collect()
}

#[derive(Deserialize)]
pub struct SignInRequest {
    profile_id: String,
    kind: Kind,
    host: String,
    client_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SignInEvent {
    /// The user must enter `user_code` on `verification_uri`. `opened` says whether
    /// we managed to open that page in their browser.
    Code {
        user_code: String,
        verification_uri: String,
        expires_in: u64,
        opened: bool,
    },
}

/// Sleeps for `d`, waking early when the flow is cancelled.
fn interruptible_sleep(d: Duration, cancel: &AtomicBool) {
    let end = Instant::now() + d;
    while Instant::now() < end && !cancel.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Runs the whole sign-in. Resolves when the user approved (credential stored),
/// declined, cancelled, or the code expired.
#[tauri::command]
pub async fn oauth_sign_in(
    profiles: State<'_, ProfileStore>,
    flows: State<'_, OAuthFlows>,
    request: SignInRequest,
    flow_id: u32,
    on_event: Channel<SignInEvent>,
) -> Result<()> {
    let store = profiles.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    flows
        .flows
        .lock()
        .map_err(|_| AppError::Internal("oauth registry poisoned".into()))?
        .insert(flow_id, cancel.clone());
    // Held until the command returns, however the sign-in ends.
    let _guard = FlowGuard {
        flows: flows.inner(),
        id: flow_id,
    };

    blocking(move || {
        if !store
            .snapshot()?
            .profiles
            .iter()
            .any(|p| p.id == request.profile_id)
        {
            return Err(AppError::profile("profile no longer exists"));
        }
        let host = request.host.trim();
        let client_id = resolve_client_id(
            request.client_id.as_deref(),
            configured_client_id(request.kind, host),
            host,
        )?;
        let provider = Provider::new(request.kind, host, &client_id).map_err(AppError::profile)?;

        let tokens = run_device_flow(
            &UreqHttp::new(),
            &provider,
            &mut |c| {
                // The page address was validated to be on the provider's own host.
                let opened = open::that_detached(&c.verification_uri).is_ok();
                let _ = on_event.send(SignInEvent::Code {
                    user_code: c.user_code.clone(),
                    verification_uri: c.verification_uri.clone(),
                    expires_in: c.expires_in,
                    opened,
                });
                Ok(())
            },
            &cancel,
            &|d| interruptible_sleep(d, &cancel),
        )
        .map_err(AppError::profile)?;

        store.set_oauth_credential(
            &request.profile_id,
            &provider.host,
            provider.credential(&tokens, now_unix()),
        )
    })
    .await
}

#[tauri::command]
pub fn oauth_cancel(flows: State<'_, OAuthFlows>, flow_id: u32) {
    if let Ok(m) = flows.flows.lock()
        && let Some(flag) = m.get(&flow_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_client_id_beats_the_configured_one() {
        let got =
            resolve_client_id(Some("  mine "), Some("built-in".into()), "github.com").unwrap();
        assert_eq!(got, "mine");
        let got = resolve_client_id(None, Some("built-in".into()), "github.com").unwrap();
        assert_eq!(got, "built-in");
        let got = resolve_client_id(Some("   "), Some("built-in".into()), "github.com").unwrap();
        assert_eq!(got, "built-in");
    }

    #[test]
    fn missing_client_id_explains_what_to_do() {
        let err = resolve_client_id(None, None, "git.corp.example")
            .unwrap_err()
            .to_string();
        assert!(err.contains("git.corp.example") && err.contains("client ID"));
    }

    #[test]
    fn built_in_ids_only_apply_to_the_default_host() {
        // SAFETY: only this test touches this variable.
        unsafe { std::env::set_var("PERSEUS_GITLAB_CLIENT_ID", "gl-built-in") };
        assert_eq!(
            configured_client_id(Kind::GitLab, "GitLab.com").as_deref(),
            Some("gl-built-in")
        );
        assert_eq!(
            configured_client_id(Kind::GitLab, "gitlab.corp.example"),
            None
        );
        unsafe { std::env::remove_var("PERSEUS_GITLAB_CLIENT_ID") };
    }
}
