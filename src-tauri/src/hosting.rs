//! Talking to GitHub and GitLab: pull / merge requests, issues and CI status.
//!
//! Everything runs in Rust. The webview never sees a token; it asks for normalized data and gets
//! it back. The HTTP layer is a trait so the provider logic is tested against canned responses.
//! Responses are cached by ETag (a `304 Not Modified` costs no rate limit on GitHub), and rate
//! limits become a readable message instead of an opaque failure.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    GitHub,
    GitLab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoRef {
    pub kind: Kind,
    pub host: String,
    /// `owner/repo`, or `group/subgroup/project` on GitLab.
    pub path: String,
}

/// Guesses the provider from the host name. Self-hosted instances are recognised by the usual
/// naming (`gitlab.example.com`, `github.example.com`).
pub fn detect_kind(host: &str) -> Option<Kind> {
    let h = host.to_ascii_lowercase();
    if h == "github.com" || h.starts_with("github.") {
        Some(Kind::GitHub)
    } else if h == "gitlab.com" || h.starts_with("gitlab.") {
        Some(Kind::GitLab)
    } else {
        None
    }
}

/// Reads `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`, and
/// `git@host:owner/repo.git`.
pub fn parse_remote(url: &str) -> Option<RepoRef> {
    let url = url.trim();
    let (host, path) = if let Some(rest) = url.split_once("://").map(|(_, r)| r) {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next()?.to_string(), path.to_string())
    } else {
        // scp-like: user@host:path
        let rest = url.rsplit_once('@').map_or(url, |(_, r)| r);
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    };
    let path = path.trim_matches('/').trim_end_matches(".git").to_string();
    let valid_host = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
    let valid_path = path.split('/').count() >= 2
        && path.split('/').all(|seg| {
            !seg.is_empty()
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        });
    if !valid_host || !valid_path {
        return None;
    }
    Some(RepoRef {
        kind: detect_kind(&host)?,
        host,
        path,
    })
}

// ---------------------------------------------------------------- HTTP layer

#[derive(Debug, Clone, Default)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
    pub etag: Option<String>,
    pub rate_remaining: Option<u64>,
    /// Unix time at which the limit resets (GitHub) .
    pub rate_reset: Option<u64>,
    /// Seconds to wait (`Retry-After`).
    pub retry_after: Option<u64>,
}

pub trait Api: Send + Sync {
    fn request(
        &self,
        method: &str,
        url: &str,
        token: Option<&str>,
        body: Option<&str>,
        etag: Option<&str>,
    ) -> std::result::Result<ApiResponse, String>;
}

const MAX_BODY: u64 = 4 * 1024 * 1024;

pub struct UreqApi {
    agent: ureq::Agent,
}

impl Default for UreqApi {
    fn default() -> Self {
        use ureq::tls::{RootCerts, TlsConfig};
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(25)))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .user_agent("Perseus")
            .build()
            .into();
        Self { agent }
    }
}

fn is_local(url: &str) -> bool {
    url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

impl Api for UreqApi {
    fn request(
        &self,
        method: &str,
        url: &str,
        token: Option<&str>,
        body: Option<&str>,
        etag: Option<&str>,
    ) -> std::result::Result<ApiResponse, String> {
        // Tokens only travel over TLS (plain HTTP is allowed to this machine, for tests).
        if !url.starts_with("https://") && !is_local(url) {
            return Err("refusing to send a request over an insecure connection".into());
        }
        let header = |r: ureq::RequestBuilder<ureq::typestate::WithBody>| r;
        let _ = header;
        let mut resp = match method {
            "GET" | "DELETE" => {
                let mut r = if method == "GET" {
                    self.agent.get(url)
                } else {
                    self.agent.delete(url)
                };
                r = r
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28");
                if let Some(t) = token {
                    r = r.header("Authorization", format!("Bearer {t}"));
                }
                if let Some(e) = etag {
                    r = r.header("If-None-Match", e);
                }
                r.call().map_err(|e| e.to_string())?
            }
            "POST" | "PUT" | "PATCH" => {
                let mut r = match method {
                    "POST" => self.agent.post(url),
                    "PUT" => self.agent.put(url),
                    _ => self.agent.patch(url),
                };
                r = r
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("Content-Type", "application/json");
                if let Some(t) = token {
                    r = r.header("Authorization", format!("Bearer {t}"));
                }
                r.send(body.unwrap_or("{}")).map_err(|e| e.to_string())?
            }
            other => return Err(format!("unsupported method {other}")),
        };
        let num = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        };
        let rate_remaining = num("x-ratelimit-remaining").or_else(|| num("ratelimit-remaining"));
        let rate_reset = num("x-ratelimit-reset").or_else(|| num("ratelimit-reset"));
        let retry_after = num("retry-after");
        let etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(ApiResponse {
            status,
            body,
            etag,
            rate_remaining,
            rate_reset,
            retry_after,
        })
    }
}

// ---------------------------------------------------------------- normalized data

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    /// Commit at the tip of the source branch, for CI lookups.
    pub head_sha: String,
    pub url: String,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub url: String,
    pub labels: Vec<String>,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    Success,
    Failure,
    Pending,
    /// No checks are configured for this commit.
    None,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewPullRequest {
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Branch with the changes.
    pub head: String,
    /// Branch to merge into.
    pub base: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrFilter {
    Open,
    Closed,
    All,
}

// ---------------------------------------------------------------- client

/// A provider client for one repository.
pub struct Client<'a> {
    pub api: &'a dyn Api,
    pub repo: RepoRef,
    pub token: Option<String>,
    pub cache: &'a Mutex<HashMap<String, (String, String)>>,
    /// Overrides `https://<host>` (tests point this at a local server).
    pub base_override: Option<String>,
}

fn s(v: &Value, ptr: &str) -> String {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn encode(path: &str) -> String {
    path.replace('/', "%2F")
}

impl Client<'_> {
    fn origin(&self) -> String {
        self.base_override
            .clone()
            .unwrap_or_else(|| format!("https://{}", self.repo.host))
    }

    fn api_root(&self) -> String {
        match self.repo.kind {
            Kind::GitHub if self.repo.host == "github.com" && self.base_override.is_none() => {
                "https://api.github.com".into()
            }
            Kind::GitHub => format!("{}/api/v3", self.origin()),
            Kind::GitLab => format!("{}/api/v4", self.origin()),
        }
    }

    /// Sends a request, translating rate limits and auth problems into readable errors.
    fn send(&self, method: &str, url: &str, body: Option<&Value>) -> Result<ApiResponse> {
        let cached = if method == "GET" {
            self.cache.lock().ok().and_then(|c| c.get(url).cloned())
        } else {
            None
        };
        let body_text = body.map(Value::to_string);
        let mut resp = self
            .api
            .request(
                method,
                url,
                self.token.as_deref(),
                body_text.as_deref(),
                cached.as_ref().map(|c| c.0.as_str()),
            )
            .map_err(|e| AppError::Internal(format!("could not reach {}: {e}", self.repo.host)))?;

        if resp.status == 304
            && let Some((_, cached_body)) = cached
        {
            resp.status = 200;
            resp.body = cached_body;
            return Ok(resp);
        }
        let limited = resp.status == 429
            || (resp.status == 403
                && (resp.rate_remaining == Some(0) || resp.retry_after.is_some()));
        if limited {
            let wait = resp
                .retry_after
                .or_else(|| {
                    resp.rate_reset
                        .map(|r| r.saturating_sub(crate::hosting::now()))
                })
                .map(|secs| {
                    format!(
                        " Try again in about {} minute(s).",
                        secs.div_ceil(60).max(1)
                    )
                })
                .unwrap_or_default();
            return Err(AppError::Internal(format!(
                "{} is rate limiting requests.{wait}",
                self.repo.host
            )));
        }
        match resp.status {
            200..=299 => {
                if method == "GET"
                    && let Some(etag) = &resp.etag
                    && let Ok(mut c) = self.cache.lock()
                {
                    c.insert(url.to_string(), (etag.clone(), resp.body.clone()));
                }
                Ok(resp)
            }
            401 => Err(AppError::Internal(format!(
                "{} rejected the sign-in. Sign in again from Profiles.",
                self.repo.host
            ))),
            403 | 404 if self.token.is_none() => Err(AppError::Internal(format!(
                "{} did not allow that without signing in. Add a token or sign in from Profiles.",
                self.repo.host
            ))),
            404 => Err(AppError::Internal(
                "not found (or your account cannot see it)".into(),
            )),
            status => {
                let detail = serde_json::from_str::<Value>(&resp.body)
                    .ok()
                    .and_then(|v| {
                        v.get("message")
                            .map(|m| m.to_string().trim_matches('"').to_string())
                            .or_else(|| {
                                v.get("error")
                                    .map(|m| m.to_string().trim_matches('"').to_string())
                            })
                    })
                    .unwrap_or_else(|| resp.body.chars().take(200).collect());
                Err(AppError::Internal(format!(
                    "{} answered {status}: {detail}",
                    self.repo.host
                )))
            }
        }
    }

    fn get_json(&self, url: &str) -> Result<Value> {
        let resp = self.send("GET", url, None)?;
        serde_json::from_str(&resp.body)
            .map_err(|e| AppError::Internal(format!("unexpected answer: {e}")))
    }

    fn project_url(&self) -> String {
        match self.repo.kind {
            Kind::GitHub => format!("{}/repos/{}", self.api_root(), self.repo.path),
            Kind::GitLab => format!("{}/projects/{}", self.api_root(), encode(&self.repo.path)),
        }
    }

    pub fn list_pull_requests(&self, filter: PrFilter) -> Result<Vec<PullRequest>> {
        let url = match self.repo.kind {
            Kind::GitHub => format!(
                "{}/pulls?state={}&per_page=50&sort=updated&direction=desc",
                self.project_url(),
                match filter {
                    PrFilter::Open => "open",
                    PrFilter::Closed => "closed",
                    PrFilter::All => "all",
                }
            ),
            Kind::GitLab => format!(
                "{}/merge_requests?state={}&per_page=50&order_by=updated_at",
                self.project_url(),
                match filter {
                    PrFilter::Open => "opened",
                    PrFilter::Closed => "closed",
                    PrFilter::All => "all",
                }
            ),
        };
        let v = self.get_json(&url)?;
        let items = v
            .as_array()
            .ok_or_else(|| AppError::Internal("unexpected answer".into()))?;
        Ok(items.iter().map(|i| self.pr_from(i)).collect())
    }

    fn pr_from(&self, i: &Value) -> PullRequest {
        match self.repo.kind {
            Kind::GitHub => {
                let merged = i.get("merged_at").is_some_and(|m| !m.is_null());
                PullRequest {
                    number: i.get("number").and_then(Value::as_u64).unwrap_or(0),
                    title: s(i, "/title"),
                    state: if merged {
                        "merged".into()
                    } else {
                        s(i, "/state")
                    },
                    draft: i.get("draft").and_then(Value::as_bool).unwrap_or(false),
                    author: s(i, "/user/login"),
                    source_branch: s(i, "/head/ref"),
                    target_branch: s(i, "/base/ref"),
                    head_sha: s(i, "/head/sha"),
                    url: s(i, "/html_url"),
                    updated: s(i, "/updated_at"),
                }
            }
            Kind::GitLab => PullRequest {
                number: i.get("iid").and_then(Value::as_u64).unwrap_or(0),
                title: s(i, "/title"),
                state: match s(i, "/state").as_str() {
                    "opened" => "open".into(),
                    other => other.to_string(),
                },
                draft: i.get("draft").and_then(Value::as_bool).unwrap_or(false)
                    || i.get("work_in_progress")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                author: s(i, "/author/username"),
                source_branch: s(i, "/source_branch"),
                target_branch: s(i, "/target_branch"),
                head_sha: s(i, "/sha"),
                url: s(i, "/web_url"),
                updated: s(i, "/updated_at"),
            },
        }
    }

    pub fn create_pull_request(&self, new: &NewPullRequest) -> Result<PullRequest> {
        if new.title.trim().is_empty() || new.head.trim().is_empty() || new.base.trim().is_empty() {
            return Err(AppError::Internal(
                "a title, a source branch and a target branch are required".into(),
            ));
        }
        let (url, body) = match self.repo.kind {
            Kind::GitHub => (
                format!("{}/pulls", self.project_url()),
                serde_json::json!({"title": new.title, "body": new.body, "head": new.head, "base": new.base, "draft": new.draft}),
            ),
            Kind::GitLab => (
                format!("{}/merge_requests", self.project_url()),
                serde_json::json!({
                    "title": if new.draft { format!("Draft: {}", new.title) } else { new.title.clone() },
                    "description": new.body,
                    "source_branch": new.head,
                    "target_branch": new.base,
                }),
            ),
        };
        let resp = self.send("POST", &url, Some(&body))?;
        let v: Value =
            serde_json::from_str(&resp.body).map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(self.pr_from(&v))
    }

    pub fn merge_pull_request(&self, number: u64, method: MergeMethod) -> Result<()> {
        match self.repo.kind {
            Kind::GitHub => {
                let m = match method {
                    MergeMethod::Merge => "merge",
                    MergeMethod::Squash => "squash",
                    MergeMethod::Rebase => "rebase",
                };
                self.send(
                    "PUT",
                    &format!("{}/pulls/{number}/merge", self.project_url()),
                    Some(&serde_json::json!({"merge_method": m})),
                )?;
            }
            Kind::GitLab => {
                if method == MergeMethod::Rebase {
                    return Err(AppError::Internal("GitLab merge requests cannot be rebase-merged from here; use merge or squash".into()));
                }
                self.send(
                    "PUT",
                    &format!("{}/merge_requests/{number}/merge", self.project_url()),
                    Some(&serde_json::json!({"squash": method == MergeMethod::Squash})),
                )?;
            }
        }
        Ok(())
    }

    pub fn list_issues(&self) -> Result<Vec<Issue>> {
        let url = match self.repo.kind {
            Kind::GitHub => format!(
                "{}/issues?state=open&per_page=50&sort=updated",
                self.project_url()
            ),
            Kind::GitLab => format!(
                "{}/issues?state=opened&per_page=50&order_by=updated_at",
                self.project_url()
            ),
        };
        let v = self.get_json(&url)?;
        let items = v
            .as_array()
            .ok_or_else(|| AppError::Internal("unexpected answer".into()))?;
        Ok(items
            .iter()
            // GitHub lists pull requests among issues; they have their own view.
            .filter(|i| i.get("pull_request").is_none())
            .map(|i| Issue {
                number: i
                    .get("number")
                    .or_else(|| i.get("iid"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                title: s(i, "/title"),
                state: match s(i, "/state").as_str() {
                    "opened" => "open".into(),
                    o => o.to_string(),
                },
                author: if self.repo.kind == Kind::GitHub {
                    s(i, "/user/login")
                } else {
                    s(i, "/author/username")
                },
                url: if self.repo.kind == Kind::GitHub {
                    s(i, "/html_url")
                } else {
                    s(i, "/web_url")
                },
                labels: i
                    .get("labels")
                    .and_then(Value::as_array)
                    .map(|l| {
                        l.iter()
                            .filter_map(|x| {
                                x.as_str().map(str::to_string).or_else(|| {
                                    x.get("name").and_then(Value::as_str).map(str::to_string)
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                updated: s(i, "/updated_at"),
            })
            .collect())
    }

    /// Combined CI state of one commit.
    pub fn ci_state(&self, sha: &str) -> Result<CiState> {
        if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::Internal("not a commit id".into()));
        }
        match self.repo.kind {
            Kind::GitHub => {
                let runs = self.get_json(&format!(
                    "{}/commits/{sha}/check-runs?per_page=100",
                    self.project_url()
                ))?;
                let status =
                    self.get_json(&format!("{}/commits/{sha}/status", self.project_url()))?;
                let mut states: Vec<&str> = runs
                    .get("check_runs")
                    .and_then(Value::as_array)
                    .map(|r| {
                        r.iter()
                            .map(|c| {
                                match (
                                    c.get("status").and_then(Value::as_str),
                                    c.get("conclusion").and_then(Value::as_str),
                                ) {
                                    (
                                        Some("completed"),
                                        Some("success" | "neutral" | "skipped"),
                                    ) => "success",
                                    (Some("completed"), _) => "failure",
                                    _ => "pending",
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if status
                    .get("total_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0
                {
                    states.push(match status.get("state").and_then(Value::as_str) {
                        Some("success") => "success",
                        Some("pending") => "pending",
                        _ => "failure",
                    });
                }
                Ok(fold(&states))
            }
            Kind::GitLab => {
                let v = self.get_json(&format!(
                    "{}/pipelines?sha={sha}&per_page=1",
                    self.project_url()
                ))?;
                let state = v
                    .as_array()
                    .and_then(|a| a.first())
                    .map(|p| s(p, "/status"));
                Ok(match state.as_deref() {
                    None => CiState::None,
                    Some("success") => CiState::Success,
                    Some("failed" | "canceled") => CiState::Failure,
                    Some(_) => CiState::Pending,
                })
            }
        }
    }
}

/// The ref a provider exposes for a pull / merge request, which git can fetch.
pub fn pull_ref(kind: Kind, number: u64) -> String {
    match kind {
        Kind::GitHub => format!("pull/{number}/head"),
        Kind::GitLab => format!("merge-requests/{number}/head"),
    }
}

fn fold(states: &[&str]) -> CiState {
    if states.is_empty() {
        CiState::None
    } else if states.contains(&"failure") {
        CiState::Failure
    } else if states.contains(&"pending") {
        CiState::Pending
    } else {
        CiState::Success
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Canned answers keyed by a URL fragment; records every request.
    /// (method, url, token, body)
    type Seen = (String, String, Option<String>, Option<String>);

    #[derive(Default)]
    struct Mock {
        routes: Vec<(String, ApiResponse)>,
        seen: StdMutex<Vec<Seen>>,
    }

    impl Mock {
        fn on(mut self, fragment: &str, status: u16, body: &str) -> Self {
            self.routes.push((
                fragment.to_string(),
                ApiResponse {
                    status,
                    body: body.to_string(),
                    ..Default::default()
                },
            ));
            self
        }
        fn on_resp(mut self, fragment: &str, resp: ApiResponse) -> Self {
            self.routes.push((fragment.to_string(), resp));
            self
        }
        fn requests(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Api for Mock {
        fn request(
            &self,
            method: &str,
            url: &str,
            token: Option<&str>,
            body: Option<&str>,
            _etag: Option<&str>,
        ) -> std::result::Result<ApiResponse, String> {
            self.seen.lock().unwrap().push((
                method.into(),
                url.into(),
                token.map(str::to_string),
                body.map(str::to_string),
            ));
            self.routes
                .iter()
                .find(|(f, _)| url.contains(f.as_str()))
                .map(|(_, r)| r.clone())
                .ok_or_else(|| format!("no route for {url}"))
        }
    }

    fn client<'a>(
        api: &'a Mock,
        kind: Kind,
        host: &str,
        path: &str,
        cache: &'a Mutex<HashMap<String, (String, String)>>,
    ) -> Client<'a> {
        Client {
            api,
            repo: RepoRef {
                kind,
                host: host.into(),
                path: path.into(),
            },
            token: Some("tok".into()),
            cache,
            base_override: None,
        }
    }

    #[test]
    fn remote_urls_are_parsed_and_unknown_hosts_rejected() {
        let gh = |u: &str| parse_remote(u).map(|r| (r.kind, r.host, r.path));
        let expect = Some((Kind::GitHub, "github.com".to_string(), "a/b".to_string()));
        assert_eq!(gh("https://github.com/a/b.git"), expect);
        assert_eq!(gh("git@github.com:a/b.git"), expect);
        assert_eq!(gh("ssh://git@github.com/a/b"), expect);
        assert_eq!(gh("https://user:pw@github.com/a/b/"), expect);
        assert_eq!(
            parse_remote("https://gitlab.com/group/sub/proj.git").map(|r| (r.kind, r.path)),
            Some((Kind::GitLab, "group/sub/proj".to_string()))
        );
        assert_eq!(
            parse_remote("https://gitlab.example.org/x/y").map(|r| r.kind),
            Some(Kind::GitLab)
        );
        for bad in [
            "",
            "https://example.com/a/b",
            "https://github.com/onlyone",
            "https://github.com/a/../b",
            "/local/path",
            "https://github.com/a/b c",
        ] {
            assert!(parse_remote(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn github_pull_requests_are_normalized_and_merged_ones_recognised() {
        let body = r#"[
          {"number":7,"title":"Fix it","state":"closed","merged_at":"2024-01-01T00:00:00Z","draft":false,"user":{"login":"ada"},
           "head":{"ref":"fix","sha":"abc123"},"base":{"ref":"main"},"html_url":"https://github.com/a/b/pull/7","updated_at":"2024-01-02T00:00:00Z"},
          {"number":8,"title":"WIP","state":"open","merged_at":null,"draft":true,"user":{"login":"bob"},
           "head":{"ref":"wip","sha":"def456"},"base":{"ref":"main"},"html_url":"https://github.com/a/b/pull/8","updated_at":"2024-01-03T00:00:00Z"}
        ]"#;
        let api = Mock::default().on("/pulls?state=all", 200, body);
        let cache = Mutex::new(HashMap::new());
        let prs = client(&api, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::All)
            .unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!(
            (prs[0].number, prs[0].state.as_str(), prs[0].author.as_str()),
            (7, "merged", "ada")
        );
        assert!(prs[1].draft && prs[1].state == "open");
        assert_eq!(
            (
                prs[1].source_branch.as_str(),
                prs[1].target_branch.as_str(),
                prs[1].head_sha.as_str()
            ),
            ("wip", "main", "def456")
        );
        let req = &api.requests()[0];
        assert!(
            req.1.starts_with("https://api.github.com/repos/a/b/pulls"),
            "{}",
            req.1
        );
        assert_eq!(req.2.as_deref(), Some("tok"));
    }

    #[test]
    fn gitlab_merge_requests_use_encoded_project_paths_and_map_states() {
        let body = r#"[{"iid":3,"title":"Add","state":"opened","draft":true,"author":{"username":"zed"},
          "source_branch":"feat","target_branch":"main","sha":"fff","web_url":"https://gitlab.com/g/s/p/-/merge_requests/3","updated_at":"t"}]"#;
        let api = Mock::default().on("/merge_requests?state=opened", 200, body);
        let cache = Mutex::new(HashMap::new());
        let prs = client(&api, Kind::GitLab, "gitlab.com", "g/s/p", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap();
        assert_eq!(
            (prs[0].number, prs[0].state.as_str(), prs[0].draft),
            (3, "open", true)
        );
        assert!(
            api.requests()[0]
                .1
                .contains("/projects/g%2Fs%2Fp/merge_requests"),
            "{}",
            api.requests()[0].1
        );
    }

    #[test]
    fn creating_a_pull_request_sends_the_right_payload_per_provider() {
        let new = NewPullRequest {
            title: "T".into(),
            body: "B".into(),
            head: "feat".into(),
            base: "main".into(),
            draft: true,
        };
        let gh = Mock::default().on("/pulls", 201, r#"{"number":9,"title":"T","state":"open","user":{"login":"me"},"head":{"ref":"feat","sha":"1"},"base":{"ref":"main"},"html_url":"u","updated_at":"t"}"#);
        let cache = Mutex::new(HashMap::new());
        let pr = client(&gh, Kind::GitHub, "github.com", "a/b", &cache)
            .create_pull_request(&new)
            .unwrap();
        assert_eq!(pr.number, 9);
        let sent: Value = serde_json::from_str(gh.requests()[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(sent["head"], "feat");
        assert_eq!(sent["draft"], true);

        let gl = Mock::default().on("/merge_requests", 201, r#"{"iid":4,"title":"Draft: T","state":"opened","author":{"username":"me"},"source_branch":"feat","target_branch":"main","sha":"2","web_url":"u","updated_at":"t"}"#);
        client(&gl, Kind::GitLab, "gitlab.com", "g/p", &cache)
            .create_pull_request(&new)
            .unwrap();
        let sent: Value = serde_json::from_str(gl.requests()[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(sent["title"], "Draft: T");
        assert_eq!(sent["source_branch"], "feat");

        let bad = NewPullRequest {
            title: " ".into(),
            ..new
        };
        assert!(
            client(&gh, Kind::GitHub, "github.com", "a/b", &cache)
                .create_pull_request(&bad)
                .is_err()
        );
    }

    #[test]
    fn issues_exclude_pull_requests_on_github() {
        let body = r#"[{"number":1,"title":"Bug","state":"open","user":{"login":"a"},"html_url":"u1","labels":[{"name":"bug"}],"updated_at":"t"},
                       {"number":2,"title":"A PR","state":"open","user":{"login":"b"},"html_url":"u2","pull_request":{},"labels":[],"updated_at":"t"}]"#;
        let api = Mock::default().on("/issues", 200, body);
        let cache = Mutex::new(HashMap::new());
        let issues = client(&api, Kind::GitHub, "github.com", "a/b", &cache)
            .list_issues()
            .unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(
            (issues[0].number, issues[0].labels.clone()),
            (1, vec!["bug".to_string()])
        );
    }

    #[test]
    fn rate_limits_and_auth_failures_become_readable_messages() {
        let cache = Mutex::new(HashMap::new());
        let limited = Mock::default().on_resp(
            "/pulls",
            ApiResponse {
                status: 403,
                body: "{}".into(),
                rate_remaining: Some(0),
                rate_reset: Some(now() + 600),
                ..Default::default()
            },
        );
        let e = client(&limited, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap_err()
            .to_string();
        assert!(e.contains("rate limiting") && e.contains("minute"), "{e}");

        let retry = Mock::default().on_resp(
            "/pulls",
            ApiResponse {
                status: 429,
                retry_after: Some(120),
                ..Default::default()
            },
        );
        let e = client(&retry, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap_err()
            .to_string();
        assert!(e.contains("2 minute"), "{e}");

        let unauthorized = Mock::default().on("/pulls", 401, "{}");
        let e = client(&unauthorized, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap_err()
            .to_string();
        assert!(e.contains("Sign in again"), "{e}");

        let anonymous = Mock::default().on("/pulls", 404, "{}");
        let mut c = client(&anonymous, Kind::GitHub, "github.com", "a/b", &cache);
        c.token = None;
        assert!(
            c.list_pull_requests(PrFilter::Open)
                .unwrap_err()
                .to_string()
                .contains("signing in")
        );

        let other = Mock::default().on("/pulls", 422, r#"{"message":"Validation Failed"}"#);
        let e = client(&other, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap_err()
            .to_string();
        assert!(e.contains("422") && e.contains("Validation Failed"), "{e}");
    }

    #[test]
    fn unchanged_lists_are_served_from_the_etag_cache() {
        let cache = Mutex::new(HashMap::new());
        let first = Mock::default().on_resp(
            "/pulls",
            ApiResponse {
                status: 200,
                body: "[]".into(),
                etag: Some("\"v1\"".into()),
                ..Default::default()
            },
        );
        client(&first, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap();
        assert_eq!(cache.lock().unwrap().len(), 1);

        // The server now answers 304: the cached body is used.
        let second = Mock::default().on_resp(
            "/pulls",
            ApiResponse {
                status: 304,
                ..Default::default()
            },
        );
        let prs = client(&second, Kind::GitHub, "github.com", "a/b", &cache)
            .list_pull_requests(PrFilter::Open)
            .unwrap();
        assert!(prs.is_empty());
    }

    #[test]
    fn ci_state_combines_check_runs_and_statuses() {
        let cache = Mutex::new(HashMap::new());
        let sha = "abc123";
        let ok = Mock::default()
            .on("/check-runs", 200, r#"{"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"skipped"}]}"#)
            .on("/status", 200, r#"{"total_count":0,"state":"pending"}"#);
        assert_eq!(
            client(&ok, Kind::GitHub, "github.com", "a/b", &cache)
                .ci_state(sha)
                .unwrap(),
            CiState::Success
        );
        let bad = Mock::default()
            .on("/check-runs", 200, r#"{"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}"#)
            .on("/status", 200, r#"{"total_count":0}"#);
        assert_eq!(
            client(&bad, Kind::GitHub, "github.com", "a/b", &cache)
                .ci_state(sha)
                .unwrap(),
            CiState::Failure
        );
        let running = Mock::default()
            .on(
                "/check-runs",
                200,
                r#"{"check_runs":[{"status":"in_progress","conclusion":null}]}"#,
            )
            .on("/status", 200, r#"{"total_count":0}"#);
        assert_eq!(
            client(&running, Kind::GitHub, "github.com", "a/b", &cache)
                .ci_state(sha)
                .unwrap(),
            CiState::Pending
        );
        let none = Mock::default()
            .on("/check-runs", 200, r#"{"check_runs":[]}"#)
            .on("/status", 200, r#"{"total_count":0}"#);
        assert_eq!(
            client(&none, Kind::GitHub, "github.com", "a/b", &cache)
                .ci_state(sha)
                .unwrap(),
            CiState::None
        );

        let gl = Mock::default().on("/pipelines", 200, r#"[{"status":"failed"}]"#);
        assert_eq!(
            client(&gl, Kind::GitLab, "gitlab.com", "g/p", &cache)
                .ci_state(sha)
                .unwrap(),
            CiState::Failure
        );
        assert!(
            client(&gl, Kind::GitLab, "gitlab.com", "g/p", &cache)
                .ci_state("--evil")
                .is_err()
        );
    }

    #[test]
    fn merging_maps_methods_and_refuses_what_gitlab_cannot_do() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on("/merge", 200, "{}");
        client(&gh, Kind::GitHub, "github.com", "a/b", &cache)
            .merge_pull_request(5, MergeMethod::Squash)
            .unwrap();
        let sent: Value = serde_json::from_str(gh.requests()[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(gh.requests()[0].0, "PUT");
        assert_eq!(sent["merge_method"], "squash");

        let gl = Mock::default().on("/merge", 200, "{}");
        let c = client(&gl, Kind::GitLab, "gitlab.com", "g/p", &cache);
        c.merge_pull_request(5, MergeMethod::Squash).unwrap();
        assert!(c.merge_pull_request(5, MergeMethod::Rebase).is_err());
        assert_eq!(pull_ref(Kind::GitLab, 5), "merge-requests/5/head");
        assert_eq!(pull_ref(Kind::GitHub, 5), "pull/5/head");
    }

    #[test]
    fn the_real_client_refuses_insecure_urls_and_works_against_a_local_server() {
        use std::io::{Read, Write};
        let api = UreqApi::default();
        assert!(
            api.request("GET", "http://example.com/x", Some("secret"), None, None)
                .unwrap_err()
                .contains("insecure")
        );

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            let reply = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"abc\"\r\nX-RateLimit-Remaining: 42\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]";
            sock.write_all(reply.as_bytes()).unwrap();
            request
        });
        let resp = api
            .request(
                "GET",
                &format!("http://127.0.0.1:{port}/repos/a/b/pulls"),
                Some("tok"),
                None,
                Some("\"old\""),
            )
            .unwrap();
        let request = server.join().unwrap();
        assert_eq!(
            (
                resp.status,
                resp.body.as_str(),
                resp.etag.as_deref(),
                resp.rate_remaining
            ),
            (200, "[]", Some("\"abc\""), Some(42))
        );
        assert!(request.contains("authorization: bearer tok"), "{request}");
        assert!(request.contains("if-none-match: \"old\""), "{request}");
    }
}
