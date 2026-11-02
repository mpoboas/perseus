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

/// Where a fork should go. Both fields are optional: by default the fork keeps the repository's
/// name and lands in the signed-in user's own account.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewFork {
    /// A different name for the fork.
    #[serde(default)]
    pub name: Option<String>,
    /// An organization (GitHub) or group (GitLab) to put it in, instead of the user's account.
    #[serde(default)]
    pub namespace: Option<String>,
}

/// A fork the host created (or already had).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Fork {
    /// `owner/name`.
    pub full_name: String,
    /// The account or group that owns it.
    pub owner: String,
    pub https_url: String,
    pub ssh_url: String,
    pub web_url: String,
}

/// A repository on a host, as the account lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RemoteRepo {
    /// `owner/name`, or `group/subgroup/name` on GitLab.
    pub full_name: String,
    /// The user, organization or group it belongs to: the heading the lists group by.
    pub owner: String,
    pub name: String,
    pub description: String,
    /// Private (or, on GitLab, internal): only signed-in people can see it.
    pub private: bool,
    pub fork: bool,
    pub https_url: String,
    pub ssh_url: String,
    pub web_url: String,
}

/// Somewhere a new repository can be created: the account itself, or an organization or group.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Namespace {
    pub path: String,
    /// The signed-in user's own account.
    pub personal: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRepo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "yes")]
    pub private: bool,
    /// An organization or group; the user's own account when absent.
    #[serde(default)]
    pub namespace: Option<String>,
}

fn yes() -> bool {
    true
}

/// A name for a new repository that both hosts accept.
pub fn valid_repo_name(name: &str) -> Result<String> {
    let name = fork_part("the name", Some(name), false)?
        .ok_or_else(|| AppError::Internal("a repository needs a name".into()))?;
    if name.ends_with(".git") {
        return Err(AppError::Internal("the name cannot end in .git".into()));
    }
    Ok(name)
}

/// How many repositories one listing asks for, and how many pages it follows: a very large account
/// gets its most recently active repositories rather than a very long wait.
const PAGE: usize = 100;
const MAX_PAGES: usize = 5;

/// Longest description either host accepts is a little over this.
const MAX_DESCRIPTION: usize = 350;

/// A repository name, user, organization or group path as the hosts allow them. Anything else is
/// refused before it reaches a request.
fn fork_part(what: &str, value: Option<&str>, slash: bool) -> Result<Option<String>> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let ok = v.len() <= 100
        && !v.starts_with(['-', '.', '/'])
        && !v.ends_with(['.', '/'])
        && !v.contains("..")
        && !v.contains("//")
        && v.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') || (slash && c == '/')
        });
    if ok {
        Ok(Some(v.to_string()))
    } else {
        Err(AppError::Internal(format!(
            "{what} has characters the host does not allow"
        )))
    }
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
            403 if resp.body.contains("insufficient_scope") => Err(AppError::Internal(format!(
                "Your sign-in to {} only allows git access. Allow the api scope in the OAuth application (see docs/oauth.md) and sign in again from Profiles.",
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

    /// Forks this repository. Hosts do it in the background, so the fork may take a moment to be
    /// cloneable; the answer already names it. Forking again returns the existing fork.
    pub fn fork(&self, new: &NewFork) -> Result<Fork> {
        if self.token.is_none() {
            return Err(AppError::Internal(format!(
                "Sign in to {} from Profiles to fork a repository.",
                self.repo.host
            )));
        }
        let name = fork_part("the name", new.name.as_deref(), false)?;
        let namespace = fork_part(
            "the owner",
            new.namespace.as_deref(),
            self.repo.kind == Kind::GitLab,
        )?;
        let (endpoint, body, owner_ptr, full_ptr, https_ptr, ssh_ptr, web_ptr) =
            match self.repo.kind {
                Kind::GitHub => {
                    let mut body = serde_json::Map::new();
                    if let Some(n) = &name {
                        body.insert("name".into(), n.clone().into());
                    }
                    if let Some(o) = &namespace {
                        body.insert("organization".into(), o.clone().into());
                    }
                    (
                        "forks",
                        Value::Object(body),
                        "/owner/login",
                        "/full_name",
                        "/clone_url",
                        "/ssh_url",
                        "/html_url",
                    )
                }
                Kind::GitLab => {
                    let mut body = serde_json::Map::new();
                    if let Some(n) = &name {
                        body.insert("name".into(), n.clone().into());
                        body.insert("path".into(), n.clone().into());
                    }
                    if let Some(o) = &namespace {
                        body.insert("namespace_path".into(), o.clone().into());
                    }
                    (
                        "fork",
                        Value::Object(body),
                        "/namespace/full_path",
                        "/path_with_namespace",
                        "/http_url_to_repo",
                        "/ssh_url_to_repo",
                        "/web_url",
                    )
                }
            };
        // GitHub names the endpoint `forks`, GitLab `fork`.
        let resp = self.send(
            "POST",
            &format!("{}/{endpoint}", self.project_url()),
            Some(&body),
        )?;
        let v: Value = serde_json::from_str(&resp.body)
            .map_err(|e| AppError::Internal(format!("unexpected answer: {e}")))?;
        let fork = Fork {
            full_name: s(&v, full_ptr),
            owner: s(&v, owner_ptr),
            https_url: s(&v, https_ptr),
            ssh_url: s(&v, ssh_ptr),
            web_url: s(&v, web_ptr),
        };
        if fork.full_name.is_empty() || fork.https_url.is_empty() {
            return Err(AppError::Internal(
                "the host's answer did not describe a fork".into(),
            ));
        }
        Ok(fork)
    }

    fn need_sign_in(&self, what: &str) -> Result<()> {
        if self.token.is_some() {
            return Ok(());
        }
        Err(AppError::Internal(format!(
            "Sign in to {} from Profiles to {what}.",
            self.repo.host
        )))
    }

    /// One repository from the host's own JSON, whichever provider it is.
    fn remote_repo(&self, v: &Value) -> RemoteRepo {
        match self.repo.kind {
            Kind::GitHub => RemoteRepo {
                full_name: s(v, "/full_name"),
                owner: s(v, "/owner/login"),
                name: s(v, "/name"),
                description: s(v, "/description"),
                private: v.get("private").and_then(Value::as_bool).unwrap_or(false),
                fork: v.get("fork").and_then(Value::as_bool).unwrap_or(false),
                https_url: s(v, "/clone_url"),
                ssh_url: s(v, "/ssh_url"),
                web_url: s(v, "/html_url"),
            },
            Kind::GitLab => RemoteRepo {
                full_name: s(v, "/path_with_namespace"),
                owner: s(v, "/namespace/full_path"),
                name: s(v, "/path"),
                description: s(v, "/description"),
                private: s(v, "/visibility") != "public",
                fork: v.get("forked_from_project").is_some_and(|f| !f.is_null()),
                https_url: s(v, "/http_url_to_repo"),
                ssh_url: s(v, "/ssh_url_to_repo"),
                web_url: s(v, "/web_url"),
            },
        }
    }

    /// The repositories the signed-in account can see (its own, its organizations' and ones it was
    /// added to), most recently active first.
    pub fn list_repositories(&self) -> Result<Vec<RemoteRepo>> {
        self.need_sign_in("list your repositories")?;
        let base = match self.repo.kind {
            Kind::GitHub => format!(
                "{}/user/repos?per_page={PAGE}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member",
                self.api_root()
            ),
            Kind::GitLab => format!(
                "{}/projects?membership=true&per_page={PAGE}&order_by=last_activity_at",
                self.api_root()
            ),
        };
        let mut all = Vec::new();
        for page in 1..=MAX_PAGES {
            let v = self.get_json(&format!("{base}&page={page}"))?;
            let items = v
                .as_array()
                .ok_or_else(|| AppError::Internal("unexpected answer".into()))?;
            all.extend(
                items
                    .iter()
                    .map(|i| self.remote_repo(i))
                    .filter(|r| !r.full_name.is_empty() && !r.https_url.is_empty()),
            );
            if items.len() < PAGE {
                break;
            }
        }
        Ok(all)
    }

    /// The repository this client was made for, from the host (its addresses are the host's, not ours).
    pub fn get_repository(&self) -> Result<RemoteRepo> {
        let r = self.remote_repo(&self.get_json(&self.project_url())?);
        if r.full_name.is_empty() || r.https_url.is_empty() {
            return Err(AppError::Internal(
                "the host's answer did not describe a repository".into(),
            ));
        }
        Ok(r)
    }

    /// Where the account can create repositories: itself first, then organizations or groups it may
    /// write to. A failure to list the organizations leaves just the account.
    pub fn list_namespaces(&self) -> Result<Vec<Namespace>> {
        self.need_sign_in("see where a repository can be created")?;
        match self.repo.kind {
            Kind::GitHub => {
                let me = s(
                    &self.get_json(&format!("{}/user", self.api_root()))?,
                    "/login",
                );
                let mut out = vec![Namespace {
                    path: me,
                    personal: true,
                }];
                if let Ok(orgs) =
                    self.get_json(&format!("{}/user/orgs?per_page={PAGE}", self.api_root()))
                {
                    for org in orgs.as_array().into_iter().flatten() {
                        let login = s(org, "/login");
                        if !login.is_empty() {
                            out.push(Namespace {
                                path: login,
                                personal: false,
                            });
                        }
                    }
                }
                Ok(out)
            }
            Kind::GitLab => Ok(self
                .gitlab_namespaces()?
                .into_iter()
                .map(|(_, path, personal)| Namespace { path, personal })
                .collect()),
        }
    }

    /// GitLab namespaces the account can create projects in, as (id, path, personal).
    fn gitlab_namespaces(&self) -> Result<Vec<(u64, String, bool)>> {
        let v = self.get_json(&format!(
            "{}/namespaces?per_page={PAGE}&min_access_level=30",
            self.api_root()
        ))?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| {
                Some((
                    n.get("id")?.as_u64()?,
                    s(n, "/full_path"),
                    s(n, "/kind") == "user",
                ))
            })
            .filter(|(_, path, _)| !path.is_empty())
            .collect())
    }

    /// Creates an empty repository (nothing is added to it: the caller pushes the first commit).
    pub fn create_repository(&self, new: &NewRepo) -> Result<RemoteRepo> {
        self.need_sign_in("create a repository")?;
        let name = valid_repo_name(&new.name)?;
        if new.description.chars().count() > MAX_DESCRIPTION
            || new.description.chars().any(char::is_control)
        {
            return Err(AppError::Internal(format!(
                "the description can have at most {MAX_DESCRIPTION} characters and no line breaks"
            )));
        }
        let namespace = fork_part(
            "the owner",
            new.namespace.as_deref(),
            self.repo.kind == Kind::GitLab,
        )?;
        let (url, body) = match self.repo.kind {
            Kind::GitHub => {
                let me = s(
                    &self.get_json(&format!("{}/user", self.api_root()))?,
                    "/login",
                );
                let url = match namespace.as_deref() {
                    Some(org) if !org.eq_ignore_ascii_case(&me) => {
                        format!("{}/orgs/{org}/repos", self.api_root())
                    }
                    _ => format!("{}/user/repos", self.api_root()),
                };
                (
                    url,
                    serde_json::json!({"name": name, "description": new.description, "private": new.private, "auto_init": false}),
                )
            }
            Kind::GitLab => {
                let mut body = serde_json::json!({
                    "name": name,
                    "path": name,
                    "description": new.description,
                    "visibility": if new.private { "private" } else { "public" },
                    "initialize_with_readme": false,
                });
                if let Some(path) = namespace {
                    let id = self
                        .gitlab_namespaces()?
                        .into_iter()
                        .find(|(_, p, _)| p.eq_ignore_ascii_case(&path))
                        .map(|(id, _, _)| id)
                        .ok_or_else(|| {
                            AppError::Internal(format!("you cannot create projects in {path}"))
                        })?;
                    body["namespace_id"] = id.into();
                }
                (format!("{}/projects", self.api_root()), body)
            }
        };
        let resp = self.send("POST", &url, Some(&body))?;
        let v: Value = serde_json::from_str(&resp.body)
            .map_err(|e| AppError::Internal(format!("unexpected answer: {e}")))?;
        let created = self.remote_repo(&v);
        if created.full_name.is_empty() || created.https_url.is_empty() {
            return Err(AppError::Internal(
                "the host's answer did not describe the new repository".into(),
            ));
        }
        Ok(created)
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
    fn forking_uses_each_providers_endpoint_and_normalizes_the_answer() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on(
            "/repos/a/b/forks",
            202,
            r#"{"full_name":"me/b2","owner":{"login":"me"},"clone_url":"https://github.com/me/b2.git","ssh_url":"git@github.com:me/b2.git","html_url":"https://github.com/me/b2"}"#,
        );
        let fork = client(&gh, Kind::GitHub, "github.com", "a/b", &cache)
            .fork(&NewFork {
                name: Some("b2".into()),
                namespace: Some("my-org".into()),
            })
            .unwrap();
        assert_eq!(fork.full_name, "me/b2");
        assert_eq!(fork.owner, "me");
        assert_eq!(fork.https_url, "https://github.com/me/b2.git");
        assert_eq!(fork.ssh_url, "git@github.com:me/b2.git");
        let seen = gh.requests();
        assert_eq!(seen.len(), 1, "one request, to the right endpoint");
        assert_eq!(seen[0].0, "POST");
        let sent: Value = serde_json::from_str(seen[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(sent["name"], "b2");
        assert_eq!(sent["organization"], "my-org");

        let gl = Mock::default().on(
            "/projects/g%2Fp/fork",
            201,
            r#"{"path_with_namespace":"me/p","namespace":{"full_path":"me"},"http_url_to_repo":"https://gitlab.com/me/p.git","ssh_url_to_repo":"git@gitlab.com:me/p.git","web_url":"https://gitlab.com/me/p"}"#,
        );
        let fork = client(&gl, Kind::GitLab, "gitlab.com", "g/p", &cache)
            .fork(&NewFork {
                name: None,
                namespace: Some("team/sub".into()),
            })
            .unwrap();
        assert_eq!(
            (fork.full_name.as_str(), fork.owner.as_str()),
            ("me/p", "me")
        );
        let sent: Value = serde_json::from_str(gl.requests()[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(sent["namespace_path"], "team/sub");
        assert!(sent.get("name").is_none(), "no name was asked for");
    }

    #[test]
    fn forking_needs_a_sign_in_and_clean_names() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on("/forks", 202, "{}");
        let mut anonymous = client(&gh, Kind::GitHub, "github.com", "a/b", &cache);
        anonymous.token = None;
        assert!(anonymous.fork(&NewFork::default()).is_err());
        assert!(gh.requests().is_empty(), "nothing is sent without a token");

        let signed_in = client(&gh, Kind::GitHub, "github.com", "a/b", &cache);
        for bad in ["-x", "a b", "a/b", "../x", "x\n", &"n".repeat(101)] {
            let new = NewFork {
                name: Some(bad.into()),
                namespace: None,
            };
            assert!(signed_in.fork(&new).is_err(), "{bad:?}");
        }
        // An answer that does not describe a fork is an error, not an empty success.
        assert!(signed_in.fork(&NewFork::default()).is_err());
    }

    #[test]
    fn forking_reports_a_hosts_refusal() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on("/forks", 403, r#"{"message":"Forking is disabled"}"#);
        let err = client(&gh, Kind::GitHub, "github.com", "a/b", &cache)
            .fork(&NewFork::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("Forking is disabled"), "{err}");
    }

    const GH_REPO: &str = r#"{"full_name":"acme/widgets","owner":{"login":"acme"},"name":"widgets","description":"Widgets","private":true,"fork":false,"clone_url":"https://github.com/acme/widgets.git","ssh_url":"git@github.com:acme/widgets.git","html_url":"https://github.com/acme/widgets"}"#;

    #[test]
    fn the_accounts_repositories_are_listed_and_normalized_per_provider() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on(
            "/user/repos",
            200,
            &format!(
                "[{GH_REPO},{}]",
                GH_REPO
                    .replace("acme/widgets", "me/own")
                    .replace(r#""login":"acme""#, r#""login":"me""#)
                    .replace(r#""private":true"#, r#""private":false"#)
            ),
        );
        let list = client(&gh, Kind::GitHub, "github.com", "", &cache)
            .list_repositories()
            .unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].full_name, "acme/widgets");
        assert_eq!(
            (list[0].owner.as_str(), list[0].private, list[0].fork),
            ("acme", true, false)
        );
        assert_eq!(list[0].https_url, "https://github.com/acme/widgets.git");
        assert_eq!((list[1].owner.as_str(), list[1].private), ("me", false));
        let url = &gh.requests()[0].1;
        assert!(
            url.contains("affiliation=owner,collaborator,organization_member")
                && url.contains("page=1"),
            "{url}"
        );

        let gl = Mock::default().on(
            "/projects",
            200,
            r#"[{"path_with_namespace":"team/sub/app","namespace":{"full_path":"team/sub"},"path":"app","description":null,"visibility":"internal","forked_from_project":{"id":3},"http_url_to_repo":"https://gitlab.com/team/sub/app.git","ssh_url_to_repo":"git@gitlab.com:team/sub/app.git","web_url":"https://gitlab.com/team/sub/app"},
                {"path_with_namespace":"me/x","namespace":{"full_path":"me"},"path":"x","visibility":"public","http_url_to_repo":"https://gitlab.com/me/x.git","ssh_url_to_repo":"","web_url":"w"}]"#,
        );
        let list = client(&gl, Kind::GitLab, "gitlab.com", "", &cache)
            .list_repositories()
            .unwrap();
        assert_eq!(list[0].full_name, "team/sub/app");
        assert_eq!(list[0].owner, "team/sub");
        assert!(
            list[0].private && list[0].fork,
            "internal counts as private; forked_from_project marks a fork"
        );
        assert!(!list[1].private && !list[1].fork);
        assert!(gl.requests()[0].1.contains("membership=true"));
    }

    #[test]
    fn long_lists_follow_pages_up_to_a_limit_and_stop_at_a_short_page() {
        let cache = Mutex::new(HashMap::new());
        let full = |n: usize| {
            let items: Vec<String> = (0..n)
                .map(|i| GH_REPO.replace("acme/widgets", &format!("acme/r{i}")))
                .collect();
            format!("[{}]", items.join(","))
        };
        let gh = Mock::default()
            .on("&page=1", 200, &full(PAGE))
            .on("&page=2", 200, &full(7));
        let list = client(&gh, Kind::GitHub, "github.com", "", &cache)
            .list_repositories()
            .unwrap();
        assert_eq!(list.len(), PAGE + 7);
        assert_eq!(
            gh.requests().len(),
            2,
            "the short second page ends the listing"
        );

        let endless = Mock::default().on("page=", 200, &full(PAGE));
        let list = client(&endless, Kind::GitHub, "github.com", "", &cache)
            .list_repositories()
            .unwrap();
        assert_eq!(list.len(), PAGE * MAX_PAGES);
        assert_eq!(endless.requests().len(), MAX_PAGES);
    }

    #[test]
    fn listing_and_creating_need_a_sign_in_and_a_scope_that_allows_them() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on("/user", 200, "[]");
        let mut anonymous = client(&gh, Kind::GitHub, "github.com", "", &cache);
        anonymous.token = None;
        assert!(anonymous.list_repositories().is_err());
        assert!(anonymous.list_namespaces().is_err());
        assert!(
            anonymous
                .create_repository(&NewRepo {
                    name: "x".into(),
                    description: String::new(),
                    private: true,
                    namespace: None
                })
                .is_err()
        );
        assert!(gh.requests().is_empty(), "nothing is sent without a token");

        let gl = Mock::default().on("/projects", 403, r#"{"error":"insufficient_scope","error_description":"The request requires higher privileges"}"#);
        let err = client(&gl, Kind::GitLab, "gitlab.com", "", &cache)
            .list_repositories()
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("api scope") && err.contains("sign in again"),
            "{err}"
        );
    }

    #[test]
    fn creation_places_a_repository_in_the_account_an_organization_or_a_group() {
        let cache = Mutex::new(HashMap::new());
        let created = GH_REPO.replace("acme/widgets", "me/fresh");
        let gh = Mock::default()
            .on("/user/repos", 201, &created)
            .on("/orgs/acme/repos", 201, GH_REPO)
            .on("/user", 200, r#"{"login":"me"}"#);
        let c = client(&gh, Kind::GitHub, "github.com", "", &cache);
        let new = |ns: Option<&str>| NewRepo {
            name: "fresh".into(),
            description: "A fresh one".into(),
            private: true,
            namespace: ns.map(str::to_string),
        };
        assert_eq!(
            c.create_repository(&new(None)).unwrap().full_name,
            "me/fresh"
        );
        c.create_repository(&new(Some("ME"))).unwrap(); // the account's own name, any case
        c.create_repository(&new(Some("acme"))).unwrap();
        let posts: Vec<_> = gh
            .requests()
            .into_iter()
            .filter(|r| r.0 == "POST")
            .collect();
        assert_eq!(posts.len(), 3);
        assert!(posts[0].1.ends_with("/user/repos") && posts[1].1.ends_with("/user/repos"));
        assert!(posts[2].1.ends_with("/orgs/acme/repos"));
        let sent: Value = serde_json::from_str(posts[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(sent["private"], true);
        assert_eq!(
            sent["auto_init"], false,
            "nothing is added: the first commit is pushed from here"
        );

        let gl = Mock::default()
            .on("/namespaces", 200, r#"[{"id":5,"full_path":"me","kind":"user"},{"id":7,"full_path":"team/sub","kind":"group"}]"#)
            .on("/projects", 201, r#"{"path_with_namespace":"team/sub/fresh","namespace":{"full_path":"team/sub"},"path":"fresh","visibility":"public","http_url_to_repo":"https://gitlab.com/team/sub/fresh.git","ssh_url_to_repo":"","web_url":"w"}"#);
        let c = client(&gl, Kind::GitLab, "gitlab.com", "", &cache);
        let made = c
            .create_repository(&NewRepo {
                private: false,
                ..new(Some("team/sub"))
            })
            .unwrap();
        assert_eq!(made.full_name, "team/sub/fresh");
        let post = gl.requests().into_iter().find(|r| r.0 == "POST").unwrap();
        let sent: Value = serde_json::from_str(post.3.as_deref().unwrap()).unwrap();
        assert_eq!(
            (sent["namespace_id"].as_u64(), sent["visibility"].as_str()),
            (Some(7), Some("public"))
        );
        assert!(
            c.create_repository(&new(Some("someone/else"))).is_err(),
            "a group the user cannot write to"
        );
    }

    #[test]
    fn creation_refuses_bad_names_and_descriptions_before_asking_the_host() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default().on("/", 200, "{}");
        let c = client(&gh, Kind::GitHub, "github.com", "", &cache);
        for bad in [
            "",
            " ",
            "a b",
            "-x",
            "x.git",
            "../x",
            "a/b",
            &"n".repeat(101),
        ] {
            let new = NewRepo {
                name: bad.into(),
                description: String::new(),
                private: true,
                namespace: None,
            };
            assert!(c.create_repository(&new).is_err(), "{bad:?}");
        }
        let long = NewRepo {
            name: "ok".into(),
            description: "d".repeat(MAX_DESCRIPTION + 1),
            private: true,
            namespace: None,
        };
        assert!(c.create_repository(&long).is_err());
        let lines = NewRepo {
            name: "ok".into(),
            description: "a\nb".into(),
            private: true,
            namespace: None,
        };
        assert!(c.create_repository(&lines).is_err());
        assert!(gh.requests().is_empty());
    }

    #[test]
    fn namespaces_list_the_account_first_then_organizations_and_survive_a_refusal() {
        let cache = Mutex::new(HashMap::new());
        let gh = Mock::default()
            .on("/user/orgs", 200, r#"[{"login":"acme"},{"login":"labs"}]"#)
            .on("/user", 200, r#"{"login":"me"}"#);
        let list = client(&gh, Kind::GitHub, "github.com", "", &cache)
            .list_namespaces()
            .unwrap();
        assert_eq!(
            list.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(),
            ["me", "acme", "labs"]
        );
        assert_eq!(list.iter().filter(|n| n.personal).count(), 1);

        let refused = Mock::default()
            .on(
                "/user/orgs",
                403,
                r#"{"message":"Resource not accessible"}"#,
            )
            .on("/user", 200, r#"{"login":"me"}"#);
        let list = client(&refused, Kind::GitHub, "github.com", "", &cache)
            .list_namespaces()
            .unwrap();
        assert_eq!(
            list.len(),
            1,
            "without read:org only the account is offered"
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
