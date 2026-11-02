//! Pull requests, issues and CI status for the open repository's hosting provider. Tokens are
//! read from the keychain here and never leave Rust.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, Result};
use crate::git::actions;
use crate::git::repo::RepoId;
use crate::git::validate;
use crate::hosting::{
    CiState, Client, Fork, Issue, Kind, MergeMethod, NewFork, NewPullRequest, PrFilter,
    PullRequest, RepoRef, UreqApi, parse_remote, pull_ref,
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

pub(crate) fn token(profiles: &ProfileStore, host: &str) -> Option<String> {
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

/// What to do locally once the host has made the fork.
#[derive(Debug, Deserialize)]
pub struct ForkRemote {
    /// Name of the remote that points at the fork. By default the fork owner's name.
    #[serde(default)]
    pub name: Option<String>,
    /// Make the fork `origin` and keep the original as `upstream`, with pushes going to the fork.
    #[serde(default)]
    pub make_origin: bool,
}

#[derive(Debug, Serialize)]
pub struct ForkOutcome {
    pub fork: Fork,
    /// The local remote that now points at the fork.
    pub remote: String,
    pub made_origin: bool,
}

/// A remote name made from the fork owner (`team/sub` becomes `team-sub`).
fn owner_remote_name(owner: &str) -> String {
    let name: String = owner
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches(['-', '.']).to_string();
    if name.is_empty() { "fork".into() } else { name }
}

/// Forks the repository on its host, then adds the fork as a remote. The remote's address comes
/// from the host's answer, never from the webview, and it uses ssh when `origin` does.
#[tauri::command]
pub async fn fork_repository(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    repo_id: RepoId,
    fork: NewFork,
    remote: ForkRemote,
) -> Result<ForkOutcome> {
    let git = git_for(&state, &profiles, repo_id)?;
    // Check what can be checked before the host does anything it cannot take back.
    let chosen = remote
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if let Some(name) = chosen {
        validate::remote_name(name)?;
    }
    let existing = {
        let git = git.clone();
        blocking(move || actions::list_remotes(&git)).await?
    };
    let has = |n: &str| existing.iter().any(|r| r.name == n);
    if remote.make_origin {
        if !has("origin") {
            return Err(AppError::Git(
                "there is no origin to keep as upstream".into(),
            ));
        }
        if has("upstream") {
            return Err(AppError::Git(
                "a remote called upstream already exists; remove or rename it first".into(),
            ));
        }
    } else if let Some(name) = chosen
        && has(name)
    {
        return Err(AppError::Git(format!(
            "a remote called {name} already exists"
        )));
    }
    let use_ssh = existing
        .iter()
        .find(|r| r.name == "origin")
        .is_some_and(|r| r.fetch_url.starts_with("git@") || r.fetch_url.starts_with("ssh://"));

    let created = with_client(&state, &hosting, &profiles, repo_id, move |c| c.fork(&fork)).await?;

    let made_origin = remote.make_origin;
    let chosen = chosen.map(str::to_string);
    let to_attach = created.clone();
    let name =
        blocking(move || attach_fork(&git, &to_attach, chosen.as_deref(), made_origin, use_ssh))
            .await?;
    Ok(ForkOutcome {
        fork: created,
        remote: name,
        made_origin,
    })
}

/// Points a local remote at the new fork and returns the remote's name. Either adds it beside the
/// existing ones, or (`make_origin`) turns the fork into `origin`, keeps the original as `upstream`
/// and sends pushes to the fork.
fn attach_fork(
    git: &crate::git::cli::Git,
    fork: &Fork,
    name: Option<&str>,
    make_origin: bool,
    use_ssh: bool,
) -> Result<String> {
    let url = if use_ssh && !fork.ssh_url.is_empty() {
        &fork.ssh_url
    } else {
        &fork.https_url
    };
    validate::remote_url(url)?;
    // The fork exists on the host by now, so every failure says so and where to add it by hand.
    let leave = |what: String| {
        AppError::Git(format!(
            "{what} The fork {} was created; add it from Remotes.",
            fork.full_name
        ))
    };
    if make_origin {
        git.output(["remote", "rename", "origin", "upstream"])
            .map_err(|e| leave(format!("Could not rename origin: {e}")))?;
        git.output(["remote", "add", "origin", "--", url.as_str()])
            .map_err(|e| leave(format!("Could not add the fork: {e}")))?;
        git.output(["config", "remote.pushDefault", "origin"])
            .map_err(|e| leave(format!("Could not set where pushes go: {e}")))?;
        return Ok("origin".to_string());
    }
    let name = name.map_or_else(|| owner_remote_name(&fork.owner), str::to_string);
    validate::remote_name(&name)?;
    if actions::list_remotes(git)?.iter().any(|r| r.name == name) {
        return Err(leave(format!("A remote called {name} already exists.")));
    }
    git.output(["remote", "add", name.as_str(), "--", url.as_str()])
        .map_err(|e| leave(format!("Could not add the fork: {e}")))?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn fork() -> Fork {
        Fork {
            full_name: "me/proj".into(),
            owner: "me".into(),
            https_url: "https://github.com/me/proj.git".into(),
            ssh_url: "git@github.com:me/proj.git".into(),
            web_url: "https://github.com/me/proj".into(),
        }
    }

    fn url_of(git: &crate::git::cli::Git, remote: &str) -> String {
        let out = git.output(["remote", "get-url", remote]).unwrap();
        String::from_utf8_lossy(&out).trim().to_string()
    }

    #[test]
    fn the_fork_is_added_as_a_remote_named_after_its_owner() {
        let (_d, git) = init_repo();
        git.output([
            "remote",
            "add",
            "origin",
            "https://github.com/acme/proj.git",
        ])
        .unwrap();
        let name = attach_fork(&git, &fork(), None, false, false).unwrap();
        assert_eq!(name, "me");
        assert_eq!(url_of(&git, "me"), "https://github.com/me/proj.git");
        assert_eq!(
            url_of(&git, "origin"),
            "https://github.com/acme/proj.git",
            "origin is untouched"
        );
    }

    #[test]
    fn a_chosen_name_and_ssh_addresses_are_honoured() {
        let (_d, git) = init_repo();
        let name = attach_fork(&git, &fork(), Some("mine"), false, true).unwrap();
        assert_eq!(name, "mine");
        assert_eq!(url_of(&git, "mine"), "git@github.com:me/proj.git");
    }

    #[test]
    fn making_the_fork_origin_keeps_the_original_as_upstream_and_pushes_to_the_fork() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "first");
        git.output([
            "remote",
            "add",
            "origin",
            "https://github.com/acme/proj.git",
        ])
        .unwrap();
        git.output(["config", "branch.main.remote", "origin"])
            .unwrap();
        git.output(["config", "branch.main.merge", "refs/heads/main"])
            .unwrap();

        let name = attach_fork(&git, &fork(), None, true, false).unwrap();

        assert_eq!(name, "origin");
        assert_eq!(url_of(&git, "origin"), "https://github.com/me/proj.git");
        assert_eq!(url_of(&git, "upstream"), "https://github.com/acme/proj.git");
        let push_default = git.output(["config", "remote.pushDefault"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&push_default).trim(), "origin");
        // Pulling still follows the original project.
        let tracked = git.output(["config", "branch.main.remote"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&tracked).trim(), "upstream");
    }

    #[test]
    fn an_existing_remote_name_is_not_overwritten_and_the_message_names_the_fork() {
        let (_d, git) = init_repo();
        git.output(["remote", "add", "me", "https://example.org/other.git"])
            .unwrap();
        let err = attach_fork(&git, &fork(), None, false, false)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("already exists") && err.contains("me/proj"),
            "{err}"
        );
        assert_eq!(url_of(&git, "me"), "https://example.org/other.git");
    }

    #[test]
    fn hostile_addresses_and_names_are_refused() {
        let (_d, git) = init_repo();
        let mut f = fork();
        f.https_url = "--upload-pack=calc".into();
        assert!(attach_fork(&git, &f, None, false, false).is_err());
        f.https_url = "ext::sh -c calc".into();
        assert!(attach_fork(&git, &f, None, false, false).is_err());
        assert!(attach_fork(&git, &fork(), Some("-x"), false, false).is_err());
        assert!(attach_fork(&git, &fork(), Some("a b"), false, false).is_err());
    }

    #[test]
    fn group_paths_make_valid_remote_names() {
        assert_eq!(owner_remote_name("team/sub"), "team-sub");
        assert_eq!(owner_remote_name("me"), "me");
        assert_eq!(owner_remote_name("//"), "fork");
    }
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
