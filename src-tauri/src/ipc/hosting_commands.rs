//! Pull requests, issues and CI status for the open repository's hosting provider. Tokens are
//! read from the keychain here and never leave Rust.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, Result};
use crate::git::actions;
use crate::git::repo::RepoId;
use crate::hosting::{
    CiState, Client, Issue, Kind, MergeMethod, NewPullRequest, PrFilter, PullRequest, RepoRef,
    UreqApi, parse_remote, pull_ref,
};
use crate::ipc::channels::AppState;
use crate::ipc::commands::{blocking, git_for};
use crate::profiles::ProfileStore;

/// Shared HTTP client and the ETag cache. Cloneable handles, so blocking work can own them.
pub struct HostingState {
    pub api: Arc<UreqApi>,
    pub cache: Arc<Mutex<HashMap<String, (String, String)>>>,
}

impl Default for HostingState {
    fn default() -> Self {
        Self {
            api: Arc::new(UreqApi::default()),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct HostingInfo {
    pub kind: Kind,
    pub host: String,
    pub path: String,
    /// The active profile holds a token for this host.
    pub signed_in: bool,
    pub web_url: String,
}

/// The provider of the repository's `origin` (or its first remote that Perseus recognises).
pub(crate) fn repo_ref(git: &crate::git::cli::Git) -> Result<Option<RepoRef>> {
    let remotes = actions::list_remotes(git)?;
    let ordered = remotes
        .iter()
        .filter(|r| r.name == "origin")
        .chain(remotes.iter().filter(|r| r.name != "origin"));
    Ok(ordered.filter_map(|r| parse_remote(&r.fetch_url)).next())
}

fn token(profiles: &ProfileStore, host: &str) -> Option<String> {
    profiles.fresh_token(host).ok().flatten()
}

#[tauri::command]
pub async fn hosting_info(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
) -> Result<Option<HostingInfo>> {
    let git = state.repos.git(repo_id)?;
    let profiles = profiles.inner().clone();
    blocking(move || {
        let Some(r) = repo_ref(&git)? else {
            return Ok(None);
        };
        Ok(Some(HostingInfo {
            signed_in: token(&profiles, &r.host).is_some(),
            web_url: format!("https://{}/{}", r.host, r.path),
            kind: r.kind,
            host: r.host,
            path: r.path,
        }))
    })
    .await
}

/// Runs `f` with a client for this repository. Errors when the remote is not GitHub or GitLab.
async fn with_client<T: Send + 'static>(
    state: &AppState,
    hosting: &HostingState,
    profiles: &ProfileStore,
    repo_id: RepoId,
    f: impl FnOnce(&Client<'_>) -> Result<T> + Send + 'static,
) -> Result<T> {
    let git = state.repos.git(repo_id)?;
    let profiles = profiles.clone();
    let api = Arc::clone(&hosting.api);
    let cache = Arc::clone(&hosting.cache);
    blocking(move || {
        let repo = repo_ref(&git)?.ok_or_else(|| {
            AppError::Internal("this repository's remote is not on GitHub or GitLab".into())
        })?;
        let token = token(&profiles, &repo.host);
        let client = Client {
            api: &*api,
            token,
            cache: &cache,
            repo,
            base_override: None,
        };
        f(&client)
    })
    .await
}

#[tauri::command]
pub async fn list_pull_requests(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    filter: PrFilter,
) -> Result<Vec<PullRequest>> {
    with_client(&state, &hosting, &profiles, repo_id, move |c| {
        c.list_pull_requests(filter)
    })
    .await
}

#[tauri::command]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    pull_request: NewPullRequest,
) -> Result<PullRequest> {
    with_client(&state, &hosting, &profiles, repo_id, move |c| {
        if c.token.is_none() {
            return Err(AppError::Internal(format!(
                "Sign in to {} from Profiles to create a pull request.",
                c.repo.host
            )));
        }
        c.create_pull_request(&pull_request)
    })
    .await
}

#[tauri::command]
pub async fn merge_pull_request(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    number: u64,
    method: MergeMethod,
) -> Result<()> {
    with_client(&state, &hosting, &profiles, repo_id, move |c| {
        c.merge_pull_request(number, method)
    })
    .await
}

#[tauri::command]
pub async fn list_issues(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
) -> Result<Vec<Issue>> {
    with_client(&state, &hosting, &profiles, repo_id, |c| c.list_issues()).await
}

#[tauri::command]
pub async fn ci_state(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    sha: String,
) -> Result<CiState> {
    with_client(&state, &hosting, &profiles, repo_id, move |c| {
        c.ci_state(&sha)
    })
    .await
}

/// Fetches a pull / merge request's head into a local branch (`pr-<n>` or `mr-<n>`) and checks
/// it out.
#[tauri::command]
pub async fn checkout_pull_request(
    state: State<'_, AppState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    number: u64,
) -> Result<String> {
    let git = git_for(&state, &profiles, repo_id)?;
    blocking(move || {
        let repo = repo_ref(&git)?.ok_or_else(|| {
            AppError::Internal("this repository's remote is not on GitHub or GitLab".into())
        })?;
        let remote_ref = pull_ref(repo.kind, number);
        let prefix = if repo.kind == Kind::GitHub {
            "pr"
        } else {
            "mr"
        };
        let branch = format!("{prefix}-{number}");
        let refspec = format!("+{remote_ref}:refs/heads/{branch}");
        // The remote the provider was detected on is `origin` for nearly every checkout; use it.
        git.output(["fetch", "origin", refspec.as_str()])?;
        git.output(["switch", "-q", branch.as_str()])?;
        Ok(branch)
    })
    .await
}

/// Opens a page of the repository's own host in the browser. Any other host is refused, so the
/// webview cannot use this to open arbitrary sites.
#[tauri::command]
pub async fn open_in_browser(
    state: State<'_, AppState>,
    repo_id: RepoId,
    url: String,
) -> Result<()> {
    let git = state.repos.git(repo_id)?;
    blocking(move || {
        let repo = repo_ref(&git)?.ok_or_else(|| {
            AppError::Internal("this repository's remote is not on GitHub or GitLab".into())
        })?;
        let parsed =
            url::Url::parse(&url).map_err(|_| AppError::Internal("not a web address".into()))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some(repo.host.as_str()) {
            return Err(AppError::Internal(format!(
                "only pages on {} can be opened from here",
                repo.host
            )));
        }
        open::that(parsed.as_str())
            .map_err(|e| AppError::Internal(format!("could not open the browser: {e}")))
    })
    .await
}
