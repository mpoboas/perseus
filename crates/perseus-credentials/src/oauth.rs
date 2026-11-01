//! OAuth 2.0 device authorization grant (RFC 8628) and refresh, for GitHub and
//! GitLab. Pure protocol logic over the [`Http`] trait: no UI, no keychain, no
//! sleeping of its own (the caller injects `sleep`), so every branch is testable.
//!
//! The device flow needs no client secret and no local web server: the user types a
//! short code on the provider's own page, and we poll until they approve.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::http::Http;
use crate::store::{Credential, OAuthState};
use crate::validate;

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_EXPIRES_IN: u64 = 900;
const DEFAULT_INTERVAL: u64 = 5;
const MAX_INTERVAL: u64 = 60;
const MAX_TRANSPORT_FAILURES: u32 = 3;

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    GitHub,
    GitLab,
}

/// An OAuth application on a specific host (github.com, gitlab.com, or a self-hosted
/// instance with its own registered app).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub kind: Kind,
    /// Normalised `host[:port]`.
    pub host: String,
    pub client_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthError {
    /// The user declined on the provider's page.
    Denied,
    /// The code expired before the user approved it.
    Expired,
    Cancelled,
    /// The refresh token was rejected; the user must sign in again.
    ReauthRequired,
    Transport(String),
    /// The provider answered with something unexpected or unsafe.
    Provider(String),
    Invalid(&'static str),
}

impl fmt::Display for OAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OAuthError::Denied => write!(f, "sign-in was declined"),
            OAuthError::Expired => write!(f, "the sign-in code expired; start again"),
            OAuthError::Cancelled => write!(f, "sign-in was cancelled"),
            OAuthError::ReauthRequired => write!(f, "the saved login expired; sign in again"),
            OAuthError::Transport(e) => write!(f, "could not reach the provider: {e}"),
            OAuthError::Provider(e) => write!(f, "provider error: {e}"),
            OAuthError::Invalid(what) => write!(f, "invalid {what}"),
        }
    }
}

impl std::error::Error for OAuthError {}

impl Provider {
    pub fn new(kind: Kind, host: &str, client_id: &str) -> Result<Self, OAuthError> {
        let host = validate::host(host).ok_or(OAuthError::Invalid("host"))?;
        let client_id = client_id.trim();
        if !validate::is_plain_text(client_id) || client_id.len() > 256 {
            return Err(OAuthError::Invalid("client id"));
        }
        Ok(Self {
            kind,
            host,
            client_id: client_id.to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        let scheme = if validate::is_loopback(&self.host) {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://{}{path}", self.host)
    }

    pub fn device_url(&self) -> String {
        match self.kind {
            Kind::GitHub => self.url("/login/device/code"),
            Kind::GitLab => self.url("/oauth/authorize_device"),
        }
    }

    pub fn token_url(&self) -> String {
        match self.kind {
            Kind::GitHub => self.url("/login/oauth/access_token"),
            Kind::GitLab => self.url("/oauth/token"),
        }
    }

    /// Enough for git over HTTPS and nothing else.
    pub fn scope(&self) -> &'static str {
        match self.kind {
            Kind::GitHub => "repo",
            Kind::GitLab => "read_repository write_repository",
        }
    }

    /// The username git sends alongside the token.
    pub fn git_username(&self) -> &'static str {
        match self.kind {
            Kind::GitHub => "x-access-token",
            Kind::GitLab => "oauth2",
        }
    }

    /// Wraps fresh tokens into the credential the keychain stores.
    pub fn credential(&self, tokens: &Tokens, now: u64) -> Credential {
        Credential {
            username: self.git_username().to_string(),
            token: tokens.access_token.clone(),
            oauth: Some(OAuthState {
                token_url: self.token_url(),
                client_id: self.client_id.clone(),
                refresh_token: tokens.refresh_token.clone(),
                expires_at: tokens.expires_in.map(|s| now.saturating_add(s)),
            }),
        }
    }
}

/// What the user needs to see to approve the sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Challenge {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

struct DeviceCode {
    device_code: String,
    challenge: Challenge,
    interval: u64,
}

fn json(body: &str) -> Result<Value, OAuthError> {
    serde_json::from_str(body)
        .map_err(|_| OAuthError::Provider("the response was not valid JSON".into()))
}

fn text<'a>(v: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| validate::is_plain_text(s) && s.len() <= max)
}

fn request_device_code(http: &dyn Http, p: &Provider) -> Result<DeviceCode, OAuthError> {
    let resp = http
        .post_form(
            &p.device_url(),
            &[("client_id", &p.client_id), ("scope", p.scope())],
        )
        .map_err(OAuthError::Transport)?;
    let v = json(&resp.body)?;
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        // The provider answered but refused this client: say which setting to look at, since
        // the error codes alone (`access_denied`!) point nowhere useful.
        let refused = matches!(
            err,
            "unauthorized_client" | "invalid_client" | "access_denied"
        );
        let hint = match (refused, p.kind) {
            (true, Kind::GitLab) => {
                " (GitLab refused this client ID. Edit the application on GitLab, tick \
                 \"Device authorization grant\" and untick \"Confidential\")"
            }
            (true, Kind::GitHub) => {
                " (GitHub refused this client ID. Check it is right and that \"Enable Device \
                 Flow\" is ticked on the OAuth app)"
            }
            _ => "",
        };
        return Err(OAuthError::Provider(format!("{err}{hint}")));
    }

    let device_code = text(&v, "device_code", 1024).ok_or(OAuthError::Invalid("device code"))?;
    let user_code = text(&v, "user_code", 64).ok_or(OAuthError::Invalid("user code"))?;
    let uri = text(&v, "verification_uri", 2048).ok_or(OAuthError::Invalid("verification URL"))?;

    // The provider tells us which page to open, so insist it is the provider's own:
    // a hostile self-hosted server must not be able to point the browser elsewhere.
    let same_host = url::Url::parse(uri).ok().is_some_and(|u| {
        let hostport = match u.port() {
            Some(port) => format!("{}:{port}", u.host_str().unwrap_or_default()),
            None => u.host_str().unwrap_or_default().to_string(),
        };
        hostport.eq_ignore_ascii_case(&p.host)
    });
    if !validate::endpoint_url(uri) || !same_host {
        return Err(OAuthError::Provider(
            "verification page is not on the provider's host".into(),
        ));
    }

    Ok(DeviceCode {
        device_code: device_code.to_string(),
        challenge: Challenge {
            user_code: user_code.to_string(),
            verification_uri: uri.to_string(),
            expires_in: v
                .get("expires_in")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_EXPIRES_IN)
                .clamp(30, 3600),
        },
        interval: v
            .get("interval")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_INTERVAL)
            .clamp(1, MAX_INTERVAL),
    })
}

fn parse_tokens(v: &Value) -> Result<Tokens, OAuthError> {
    let access_token = text(v, "access_token", 4096).ok_or(OAuthError::Invalid("access token"))?;
    let refresh_token = match v.get("refresh_token") {
        None | Some(Value::Null) => None,
        Some(_) => Some(
            text(v, "refresh_token", 4096)
                .ok_or(OAuthError::Invalid("refresh token"))?
                .to_string(),
        ),
    };
    Ok(Tokens {
        access_token: access_token.to_string(),
        refresh_token,
        expires_in: v.get("expires_in").and_then(Value::as_u64),
    })
}

/// Runs the whole device flow. `on_challenge` receives the code to show (and
/// typically opens the verification page); returning an error aborts the flow.
/// `sleep` waits for the polling interval and should return early on cancel.
pub fn run_device_flow(
    http: &dyn Http,
    provider: &Provider,
    on_challenge: &mut dyn FnMut(&Challenge) -> Result<(), OAuthError>,
    cancel: &AtomicBool,
    sleep: &dyn Fn(Duration),
) -> Result<Tokens, OAuthError> {
    let dc = request_device_code(http, provider)?;
    on_challenge(&dc.challenge)?;

    let mut interval = dc.interval;
    let mut waited = 0u64;
    let mut failures = 0u32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OAuthError::Cancelled);
        }
        sleep(Duration::from_secs(interval));
        if cancel.load(Ordering::Relaxed) {
            return Err(OAuthError::Cancelled);
        }
        waited += interval;
        if waited > dc.challenge.expires_in + interval {
            return Err(OAuthError::Expired);
        }

        let resp = http.post_form(
            &provider.token_url(),
            &[
                ("client_id", &provider.client_id),
                ("device_code", &dc.device_code),
                ("grant_type", DEVICE_GRANT),
            ],
        );
        let resp = match resp {
            Ok(r) => {
                failures = 0;
                r
            }
            Err(e) => {
                // A flaky network should not abort a sign-in the user is mid-way through.
                failures += 1;
                if failures >= MAX_TRANSPORT_FAILURES {
                    return Err(OAuthError::Transport(e));
                }
                continue;
            }
        };

        let v = json(&resp.body)?;
        if v.get("access_token").is_some() {
            return parse_tokens(&v);
        }
        match v.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                // RFC 8628: back off by at least five seconds; honour a larger value if given.
                let given = v.get("interval").and_then(Value::as_u64).unwrap_or(0);
                interval = (interval + 5).max(given).min(MAX_INTERVAL * 2);
            }
            Some("expired_token") => return Err(OAuthError::Expired),
            Some("access_denied") => return Err(OAuthError::Denied),
            Some(other) => {
                let desc = v
                    .get("error_description")
                    .and_then(Value::as_str)
                    .filter(|d| validate::is_plain_text(d))
                    .unwrap_or("");
                return Err(OAuthError::Provider(
                    format!("{other} {desc}").trim().to_string(),
                ));
            }
            None => {
                return Err(OAuthError::Provider(format!(
                    "unexpected response (status {})",
                    resp.status
                )));
            }
        }
    }
}

/// Exchanges a refresh token for a new access token.
pub fn refresh(
    http: &dyn Http,
    token_url: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<Tokens, OAuthError> {
    let resp = http
        .post_form(
            token_url,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh_token),
            ],
        )
        .map_err(OAuthError::Transport)?;
    let v = json(&resp.body)?;
    if v.get("access_token").is_some() {
        return parse_tokens(&v);
    }
    match v.get("error").and_then(Value::as_str) {
        // The token was revoked, rotated by another client, or expired for good.
        Some("invalid_grant") | Some("invalid_token") => Err(OAuthError::ReauthRequired),
        Some(other) => Err(OAuthError::Provider(other.to_string())),
        None => Err(OAuthError::Provider(format!(
            "unexpected response (status {})",
            resp.status
        ))),
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use crate::http::{Http, HttpResponse};

    /// One recorded request: the URL and its form fields.
    pub type Recorded = (String, Vec<(String, String)>);

    /// Replays canned responses and records every request.
    #[derive(Default)]
    pub struct FakeHttp {
        pub responses: Mutex<VecDeque<Result<HttpResponse, String>>>,
        pub requests: Mutex<Vec<Recorded>>,
    }

    impl FakeHttp {
        pub fn json(self, status: u16, body: &str) -> Self {
            self.responses.lock().unwrap().push_back(Ok(HttpResponse {
                status,
                body: body.to_string(),
            }));
            self
        }
        pub fn fail(self, msg: &str) -> Self {
            self.responses
                .lock()
                .unwrap()
                .push_back(Err(msg.to_string()));
            self
        }
        pub fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    impl Http for FakeHttp {
        fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<HttpResponse, String> {
            self.requests.lock().unwrap().push((
                url.to_string(),
                form.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected extra request")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::testutil::FakeHttp;
    use super::*;

    fn github() -> Provider {
        Provider::new(Kind::GitHub, "github.com", "Iv1.abc").unwrap()
    }

    fn gitlab() -> Provider {
        Provider::new(Kind::GitLab, "gitlab.example.org:8443", "gl-client").unwrap()
    }

    const DEVICE: &str = r#"{"device_code":"dev123","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;
    const PENDING: &str = r#"{"error":"authorization_pending"}"#;
    const TOKENS: &str = r#"{"access_token":"gho_abc","token_type":"bearer","scope":"repo"}"#;

    fn run(
        http: &FakeHttp,
        p: &Provider,
    ) -> (Result<Tokens, OAuthError>, Vec<u64>, Vec<Challenge>) {
        let cancel = AtomicBool::new(false);
        let sleeps = RefCell::new(Vec::new());
        let mut seen = Vec::new();
        let res = run_device_flow(
            http,
            p,
            &mut |c| {
                seen.push(c.clone());
                Ok(())
            },
            &cancel,
            &|d| sleeps.borrow_mut().push(d.as_secs()),
        );
        (res, sleeps.into_inner(), seen)
    }

    #[test]
    fn endpoints_per_provider() {
        let g = github();
        assert_eq!(g.device_url(), "https://github.com/login/device/code");
        assert_eq!(g.token_url(), "https://github.com/login/oauth/access_token");
        let l = gitlab();
        assert_eq!(
            l.device_url(),
            "https://gitlab.example.org:8443/oauth/authorize_device"
        );
        assert_eq!(l.token_url(), "https://gitlab.example.org:8443/oauth/token");
        assert_eq!(l.git_username(), "oauth2");
        assert!(Provider::new(Kind::GitHub, "evil.com/path", "x").is_err());
        assert!(Provider::new(Kind::GitHub, "github.com", "  ").is_err());
        assert!(Provider::new(Kind::GitHub, "github.com", "a\nb").is_err());
    }

    #[test]
    fn happy_path_waits_polls_and_returns_tokens() {
        let http = FakeHttp::default()
            .json(200, DEVICE)
            .json(200, PENDING)
            .json(200, PENDING)
            .json(200, TOKENS);
        let (res, sleeps, seen) = run(&http, &github());

        let tokens = res.unwrap();
        assert_eq!(tokens.access_token, "gho_abc");
        assert_eq!(tokens.refresh_token, None);
        assert_eq!(sleeps, [5, 5, 5]);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].user_code, "WDJB-MJHT");
        assert_eq!(seen[0].verification_uri, "https://github.com/login/device");

        // The first request asks for device code with our scope; polls carry the grant type.
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].0, "https://github.com/login/device/code");
        assert!(reqs[0].1.contains(&("scope".into(), "repo".into())));
        assert_eq!(reqs[1].0, "https://github.com/login/oauth/access_token");
        assert!(
            reqs[1]
                .1
                .contains(&("grant_type".into(), DEVICE_GRANT.into()))
        );
        assert!(reqs[1].1.contains(&("device_code".into(), "dev123".into())));
        // No client secret is ever sent.
        assert!(
            reqs.iter()
                .all(|(_, f)| f.iter().all(|(k, _)| k != "client_secret"))
        );
    }

    #[test]
    fn slow_down_backs_off_by_at_least_five_seconds() {
        let http = FakeHttp::default()
            .json(200, DEVICE)
            .json(200, PENDING)
            .json(200, r#"{"error":"slow_down"}"#)
            .json(200, r#"{"error":"slow_down","interval":20}"#)
            .json(200, TOKENS);
        let (res, sleeps, _) = run(&http, &github());
        assert!(res.is_ok());
        assert_eq!(sleeps, [5, 5, 10, 20]);
    }

    #[test]
    fn gitlab_style_400_error_bodies_are_understood() {
        let device = r#"{"device_code":"d","user_code":"ABCD-1234","verification_uri":"https://gitlab.example.org:8443/oauth/device","expires_in":300,"interval":2}"#;
        let http = FakeHttp::default()
            .json(200, device)
            .json(400, PENDING)
            .json(200, r#"{"access_token":"glo_x","refresh_token":"glr_y","expires_in":7200,"token_type":"Bearer"}"#);
        let (res, sleeps, _) = run(&http, &gitlab());
        let t = res.unwrap();
        assert_eq!(t.refresh_token.as_deref(), Some("glr_y"));
        assert_eq!(t.expires_in, Some(7200));
        assert_eq!(sleeps, [2, 2]);
    }

    #[test]
    fn terminal_errors_map_to_distinct_outcomes() {
        let denied = FakeHttp::default()
            .json(200, DEVICE)
            .json(200, r#"{"error":"access_denied"}"#);
        assert_eq!(run(&denied, &github()).0.unwrap_err(), OAuthError::Denied);

        let expired = FakeHttp::default()
            .json(200, DEVICE)
            .json(200, r#"{"error":"expired_token"}"#);
        assert_eq!(run(&expired, &github()).0.unwrap_err(), OAuthError::Expired);

        let other = FakeHttp::default().json(200, DEVICE).json(
            200,
            r#"{"error":"unsupported_grant_type","error_description":"enable device flow"}"#,
        );
        match run(&other, &github()).0.unwrap_err() {
            OAuthError::Provider(m) => {
                assert!(m.contains("unsupported_grant_type") && m.contains("enable"))
            }
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn gives_up_when_the_code_would_have_expired() {
        // 30s is the minimum lifetime; with a 10s interval pending forever must end in Expired.
        let device = r#"{"device_code":"d","user_code":"A-B","verification_uri":"https://github.com/login/device","expires_in":30,"interval":10}"#;
        let mut http = FakeHttp::default().json(200, device);
        for _ in 0..10 {
            http = http.json(200, PENDING);
        }
        let (res, sleeps, _) = run(&http, &github());
        assert_eq!(res.unwrap_err(), OAuthError::Expired);
        assert!(sleeps.len() <= 5, "kept polling too long: {sleeps:?}");
    }

    #[test]
    fn cancelling_stops_before_the_next_request() {
        let http = FakeHttp::default().json(200, DEVICE);
        let cancel = AtomicBool::new(false);
        let res = run_device_flow(&http, &github(), &mut |_| Ok(()), &cancel, &|_| {
            cancel.store(true, Ordering::Relaxed)
        });
        assert_eq!(res.unwrap_err(), OAuthError::Cancelled);
        assert_eq!(http.count(), 1, "no poll should follow a cancel");
    }

    #[test]
    fn transient_network_errors_are_retried_but_not_forever() {
        let ok = FakeHttp::default()
            .json(200, DEVICE)
            .fail("timeout")
            .fail("timeout")
            .json(200, TOKENS);
        assert!(run(&ok, &github()).0.is_ok());

        let down = FakeHttp::default()
            .json(200, DEVICE)
            .fail("down")
            .fail("down")
            .fail("down");
        assert!(matches!(
            run(&down, &github()).0,
            Err(OAuthError::Transport(_))
        ));
    }

    #[test]
    fn a_hostile_device_response_is_rejected() {
        let bad = |extra: &str| {
            format!(
                r#"{{"device_code":"d","user_code":"A-B","expires_in":300,"interval":5,{extra}}}"#
            )
        };
        for uri in [
            r#""verification_uri":"https://evil.example/login/device""#,
            r#""verification_uri":"http://github.com/login/device""#,
            r#""verification_uri":"javascript:alert(1)""#,
            r#""verification_uri":"https://github.com.evil.example/x""#,
            r#""verification_uri":"https://user@github.com/x""#,
        ] {
            let http = FakeHttp::default().json(200, &bad(uri));
            let (res, _, seen) = run(&http, &github());
            assert!(matches!(res, Err(OAuthError::Provider(_))), "{uri}");
            assert!(seen.is_empty(), "the user must never be shown {uri}");
        }
        // Control characters in the user code are refused too.
        let http = FakeHttp::default().json(
            200,
            r#"{"device_code":"d","user_code":"A\nB","verification_uri":"https://github.com/login/device"}"#,
        );
        assert!(run(&http, &github()).0.is_err());
    }

    #[test]
    fn setup_errors_come_with_a_useful_hint() {
        // Each provider gets advice about its own setting, not a generic message.
        let cases = [
            (github(), "unauthorized_client", "Enable Device Flow"),
            (gitlab(), "access_denied", "Device authorization grant"),
            (gitlab(), "invalid_client", "untick \"Confidential\""),
        ];
        for (provider, error, advice) in cases {
            let http = FakeHttp::default().json(400, &format!(r#"{{"error":"{error}"}}"#));
            match run(&http, &provider).0.unwrap_err() {
                OAuthError::Provider(m) => assert!(m.contains(error) && m.contains(advice), "{m}"),
                e => panic!("{e:?}"),
            }
        }

        // Unrelated errors stay unadorned.
        let http = FakeHttp::default().json(400, r#"{"error":"invalid_scope"}"#);
        match run(&http, &gitlab()).0.unwrap_err() {
            OAuthError::Provider(m) => assert_eq!(m, "invalid_scope"),
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn credential_records_expiry_and_refresh_state() {
        let t = Tokens {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in: Some(7200),
        };
        let c = gitlab().credential(&t, 1_000);
        assert_eq!(c.username, "oauth2");
        let o = c.oauth.unwrap();
        assert_eq!(o.expires_at, Some(8_200));
        assert_eq!(o.refresh_token.as_deref(), Some("r"));
        assert_eq!(o.token_url, "https://gitlab.example.org:8443/oauth/token");
        assert_eq!(o.client_id, "gl-client");

        // GitHub OAuth-app tokens do not expire.
        let never = github().credential(
            &Tokens {
                access_token: "a".into(),
                refresh_token: None,
                expires_in: None,
            },
            5,
        );
        assert_eq!(never.oauth.unwrap().expires_at, None);
    }

    #[test]
    fn refresh_success_and_revocation() {
        let ok = FakeHttp::default().json(
            200,
            r#"{"access_token":"new","refresh_token":"rot","expires_in":7200}"#,
        );
        let t = refresh(&ok, "https://gitlab.com/oauth/token", "cid", "old").unwrap();
        assert_eq!(
            (t.access_token.as_str(), t.refresh_token.as_deref()),
            ("new", Some("rot"))
        );
        let req = &ok.requests.lock().unwrap()[0];
        assert!(
            req.1
                .contains(&("grant_type".into(), "refresh_token".into()))
        );
        assert!(req.1.contains(&("refresh_token".into(), "old".into())));

        let revoked = FakeHttp::default().json(400, r#"{"error":"invalid_grant"}"#);
        assert_eq!(
            refresh(&revoked, "https://gitlab.com/oauth/token", "cid", "old").unwrap_err(),
            OAuthError::ReauthRequired
        );
    }

    #[test]
    fn debug_output_hides_tokens() {
        let t = Tokens {
            access_token: "SECRET-A".into(),
            refresh_token: Some("SECRET-R".into()),
            expires_in: None,
        };
        let shown = format!("{t:?}");
        assert!(!shown.contains("SECRET"));
    }
}
