//! The signed-in GitHub or GitLab account: choosing where things go on disk, browsing the
//! account's repositories, cloning one (optionally through a fork of it) and creating a new
//! repository that is published straight away.
//!
//! Folders are chosen only in a native dialog opened from here. The webview gets an opaque number
//! for the folder (and its path to show), and hands the number back, so it can never name a
//! folder of its own. Hosts are limited to GitHub and GitLab hosts the profile can sign in to, and
//! every address that ends up in git comes from the host's answer, never from the webview.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::git::cli::{Git, GitOverrides};
use crate::git::clone;
use crate::git::repo::RepoInfo;
use crate::hosting::{
    Client, Fork, Kind, Namespace, NewFork, NewRepo, RemoteRepo, RepoRef, detect_kind,
    valid_repo_name,
};
use crate::ipc::channels::AppState;
use crate::ipc::commands::blocking;
use crate::ipc::hosting_commands::{HostingState, token};
use crate::profiles::{ProfileStore, helper_path};
use crate::recents::RecentStore;

// ---------------------------------------------------------------- folders

/// Folders the user picked in the native dialog, by number, plus the last parent folder used.
pub struct Folders {
    next: AtomicU32,
    picks: Mutex<HashMap<u32, PathBuf>>,
    last_file: PathBuf,
}

/// Most picks kept at once; the oldest go first.
const MAX_PICKS: usize = 16;

impl Folders {
    pub fn new(last_file: PathBuf) -> Self {
        Self {
            next: AtomicU32::new(1),
            picks: Mutex::new(HashMap::new()),
            last_file,
        }
    }

    fn add(&self, path: PathBuf) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut picks) = self.picks.lock() {
            if picks.len() >= MAX_PICKS
                && let Some(oldest) = picks.keys().min().copied()
            {
                picks.remove(&oldest);
            }
            picks.insert(id, path);
        }
        id
    }

    pub(crate) fn get(&self, id: u32) -> Result<PathBuf> {
        self.picks
            .lock()
            .ok()
            .and_then(|p| p.get(&id).cloned())
            .ok_or_else(|| AppError::Git("choose a folder first".into()))
    }

    /// The last parent folder a repository was cloned or created in, when it still exists.
    fn last(&self) -> Option<PathBuf> {
        let text = std::fs::read_to_string(&self.last_file).ok()?;
        let dir = PathBuf::from(text.trim());
        dir.is_dir().then_some(dir)
    }

    pub(crate) fn remember(&self, dir: &Path) {
        let _ = std::fs::write(&self.last_file, dir.to_string_lossy().as_bytes());
    }
}

#[derive(Debug, Serialize)]
pub struct ChosenFolder {
    pub id: u32,
    pub path: String,
}

/// Asks for a folder in a native dialog (`pick`), or offers the one used last without asking.
/// The answer is a number the other commands in this module accept, and the path to show.
#[tauri::command]
pub async fn choose_folder(
    app: AppHandle,
    folders: State<'_, Folders>,
    pick: bool,
) -> Result<Option<ChosenFolder>> {
    let last = folders.last();
    let dir = if pick {
        let start = last.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            let mut dialog = app.dialog().file();
            if let Some(start) = start {
                dialog = dialog.set_directory(start);
            }
            dialog.blocking_pick_folder()
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
        match picked {
            Some(p) => Some(
                p.into_path()
                    .map_err(|e| AppError::Internal(e.to_string()))?,
            ),
            None => None,
        }
    } else {
        last
    };
    Ok(dir.map(|path| ChosenFolder {
        path: path.to_string_lossy().into_owned(),
        id: folders.add(path),
    }))
}

// ---------------------------------------------------------------- hosts

/// End-to-end tests point the account calls at a fake host on this machine. This only works when
/// the app data is redirected too (`PERSEUS_DATA_DIR`, which a normal run never sets) and only for
/// a plain `http://127.0.0.1:<port>` address, so a token can never be sent anywhere else.
fn test_origin() -> Option<String> {
    std::env::var_os("PERSEUS_DATA_DIR")?;
    let origin = std::env::var("PERSEUS_TEST_HOST_ORIGIN").ok()?;
    let port = origin.strip_prefix("http://127.0.0.1:")?;
    (!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())).then_some(origin)
}

/// The two default hosts and any other GitHub or GitLab host the active profile is signed in to.
fn known_hosts(profiles: &ProfileStore) -> Vec<String> {
    let mut hosts = vec!["github.com".to_string(), "gitlab.com".to_string()];
    if let Some(active) = profiles.active() {
        for c in active.credentials {
            let host = c.host.to_ascii_lowercase();
            if detect_kind(&host).is_some() && !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    }
    hosts
}

/// `host` as the profile knows it, refused unless it is one of [`known_hosts`].
fn allowed_host(profiles: &ProfileStore, host: &str) -> Result<(String, Kind)> {
    let host = host.trim().to_ascii_lowercase();
    if known_hosts(profiles).contains(&host)
        && let Some(kind) = detect_kind(&host)
    {
        return Ok((host, kind));
    }
    Err(AppError::Internal(
        "Perseus can use repositories on GitHub and GitLab hosts you are signed in to".into(),
    ))
}

/// Segments of `owner/name` (or a GitLab group path), each made of plain characters.
fn repo_path(full_name: &str) -> Result<String> {
    let segments: Vec<&str> = full_name.trim().split('/').collect();
    let ok = (2..=10).contains(&segments.len())
        && segments.iter().all(|s| {
            !s.is_empty()
                && s.len() <= 100
                && *s != "."
                && *s != ".."
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        });
    if ok {
        Ok(segments.join("/"))
    } else {
        Err(AppError::Internal(
            "that is not a repository name on the host".into(),
        ))
    }
}

/// Runs `f` with a client for `host` (and the repository `path`, empty for account-wide calls).
async fn with_host<T: Send + 'static>(
    hosting: &HostingState,
    profiles: &ProfileStore,
    host: &str,
    path: &str,
    f: impl FnOnce(&Client<'_>) -> Result<T> + Send + 'static,
) -> Result<T> {
    let (host, kind) = allowed_host(profiles, host)?;
    let profiles = profiles.clone();
    let api = Arc::clone(&hosting.api);
    let cache = Arc::clone(&hosting.cache);
    let path = path.to_string();
    blocking(move || {
        let base_override = test_origin();
        let token = token(&profiles, &host)
            .or_else(|| base_override.as_ref().map(|_| "e2e-token".to_string()));
        let client = Client {
            api: &*api,
            token,
            cache: &cache,
            repo: RepoRef { kind, host, path },
            base_override,
        };
        f(&client)
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct HostAccount {
    pub host: String,
    pub kind: Kind,
    /// The active profile holds a login for this host.
    pub signed_in: bool,
}

/// The hosts the clone and create dialogs offer, and whether the active profile is signed in to each.
#[tauri::command]
pub fn host_accounts(profiles: State<'_, ProfileStore>) -> Vec<HostAccount> {
    let signed: Vec<String> = profiles
        .active()
        .map(|p| {
            p.credentials
                .iter()
                .map(|c| c.host.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();
    let in_test = test_origin().is_some();
    known_hosts(&profiles)
        .into_iter()
        .filter_map(|host| {
            Some(HostAccount {
                kind: detect_kind(&host)?,
                signed_in: in_test || signed.contains(&host),
                host,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_remote_repositories(
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    host: String,
) -> Result<Vec<RemoteRepo>> {
    with_host(&hosting, &profiles, &host, "", |c| c.list_repositories()).await
}

/// Where the account can create a repository: itself, then its organizations or groups.
#[tauri::command]
pub async fn list_namespaces(
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    host: String,
) -> Result<Vec<Namespace>> {
    with_host(&hosting, &profiles, &host, "", |c| c.list_namespaces()).await
}

// ---------------------------------------------------------------- cloning

fn overrides_of(profiles: &ProfileStore) -> Result<GitOverrides> {
    match profiles.active() {
        Some(profile) => profile.git_overrides(helper_path().as_deref()),
        None => Ok(GitOverrides::default()),
    }
}

/// Registers a cancel flag for `op_id` (see `cancel_git_op`).
fn start_op(state: &AppState, op_id: u32) -> Result<Arc<AtomicBool>> {
    let flag = Arc::new(AtomicBool::new(false));
    state
        .ops
        .lock()
        .map_err(|_| AppError::Internal("operation registry poisoned".into()))?
        .insert(op_id, Arc::clone(&flag));
    Ok(flag)
}

fn end_op(state: &AppState, op_id: u32, flag: &Arc<AtomicBool>) {
    if let Ok(mut ops) = state.ops.lock()
        && ops.get(&op_id).is_some_and(|f| Arc::ptr_eq(f, flag))
    {
        ops.remove(&op_id);
    }
}

/// A new fork may take a moment before the host lets anyone clone it.
const FORK_ATTEMPTS: u32 = 10;
const FORK_WAIT: Duration = Duration::from_secs(2);

fn wait_or_cancel(cancel: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < total && !cancel.load(Ordering::Relaxed) {
        std::thread::sleep(step);
        waited += step;
    }
}

/// Clones `full_name` from `host` into the chosen folder. With `fork` the repository is forked to
/// the signed-in account (or the owner named there) first, the fork is cloned, and the original is
/// kept as the remote `upstream`.
// Every argument is injected application state or a value from the webview.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn clone_from_host(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    recents: State<'_, RecentStore>,
    folders: State<'_, Folders>,
    host: String,
    full_name: String,
    fork: Option<NewFork>,
    folder: u32,
    op_id: u32,
    on_progress: Channel<String>,
) -> Result<RepoInfo> {
    let parent = folders.get(folder)?;
    let path = repo_path(&full_name)?;
    let overrides = overrides_of(&profiles)?;
    let cancel = start_op(&state, op_id)?;

    let record = with_host(&hosting, &profiles, &host, &path, |c| c.get_repository()).await;
    let outcome = async {
        let original = record?;
        let (url, forked) = match fork {
            Some(options) => {
                let _ = on_progress.send(format!("Forking {path}…"));
                let made: Fork =
                    with_host(&hosting, &profiles, &host, &path, move |c| c.fork(&options)).await?;
                (made.https_url, true)
            }
            None => (original.https_url.clone(), false),
        };
        let flag = Arc::clone(&cancel);
        let progress = on_progress.clone();
        let upstream = forked.then(|| original.https_url.clone());
        let target = blocking(move || {
            let mut attempt = 0;
            let target = loop {
                match clone::clone_into(&parent, &url, overrides.clone(), &flag, |l| {
                    let _ = progress.send(l.to_string());
                }) {
                    Ok(t) => break t,
                    Err(_)
                        if forked && attempt < FORK_ATTEMPTS && !flag.load(Ordering::Relaxed) =>
                    {
                        attempt += 1;
                        let _ = progress.send("Waiting for the host to finish the fork…".into());
                        wait_or_cancel(&flag, FORK_WAIT);
                    }
                    Err(e) => return Err(e),
                }
            };
            if let Some(original) = upstream {
                // The fork is `origin`; the project it came from is `upstream`.
                let _ = Git::new(&target).output([
                    "remote",
                    "add",
                    "upstream",
                    "--",
                    original.as_str(),
                ]);
            }
            Ok(target)
        })
        .await?;
        let info = state.repos.open(&target)?;
        recents.touch(&info.path.to_string_lossy(), &info.name)?;
        if let Some(parent) = target.parent() {
            folders.remember(parent);
        }
        Ok::<_, AppError>(info)
    }
    .await;
    end_op(&state, op_id, &cancel);
    outcome
}

// ---------------------------------------------------------------- creating

#[derive(Debug, Deserialize)]
pub struct Publish {
    pub host: String,
    #[serde(default = "yes")]
    pub private: bool,
    /// An organization or group; the account itself when absent.
    #[serde(default)]
    pub namespace: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Start with a README naming the project.
    #[serde(default)]
    pub readme: bool,
    #[serde(default)]
    pub default_branch: Option<String>,
    pub folder: u32,
    /// Also create it on a host and push the first commit there.
    #[serde(default)]
    pub publish: Option<Publish>,
}

#[derive(Debug, Serialize)]
pub struct CreateOutcome {
    pub info: RepoInfo,
    /// The repository's page on the host, once it was published.
    pub published: Option<String>,
    /// Something that did not work after the repository was made (the host refused it, the push
    /// failed). The repository itself exists and is open.
    pub warning: Option<String>,
}

/// Creates `<folder>/<name>` as a repository. With `publish` it also creates the repository on the
/// host and pushes the first commit, so it is on GitHub or GitLab straight away. The local
/// repository is made first, so a refusal from the host never loses the work.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_repository(
    state: State<'_, AppState>,
    hosting: State<'_, HostingState>,
    profiles: State<'_, ProfileStore>,
    recents: State<'_, RecentStore>,
    folders: State<'_, Folders>,
    request: CreateRequest,
    op_id: u32,
    on_progress: Channel<String>,
) -> Result<CreateOutcome> {
    let parent = folders.get(request.folder)?;
    let local_name = clone::local_folder_name(&request.name)?;
    if request.description.chars().any(char::is_control)
        || request.description.chars().count() > 350
    {
        return Err(AppError::Git(
            "the description can have at most 350 characters and no line breaks".into(),
        ));
    }
    if request.publish.is_some() {
        // Known before anything is made: a name the host would refuse is not worth a folder.
        valid_repo_name(&local_name)?;
    }
    let overrides = overrides_of(&profiles)?;
    let cancel = start_op(&state, op_id)?;

    let made = {
        let (name, description, branch) = (
            local_name.clone(),
            request.description.clone(),
            request.default_branch.clone(),
        );
        let (readme, publish, overrides) =
            (request.readme, request.publish.is_some(), overrides.clone());
        let parent = parent.clone();
        blocking(move || {
            clone::create_local(
                &parent,
                &name,
                &description,
                branch.as_deref(),
                readme,
                publish,
                overrides,
            )
        })
        .await
    };
    let target = match made {
        Ok(t) => t,
        Err(e) => {
            end_op(&state, op_id, &cancel);
            return Err(e);
        }
    };

    let mut published = None;
    let mut warning = None;
    if let Some(publish) = request.publish {
        let new = NewRepo {
            name: local_name.clone(),
            description: request.description.clone(),
            private: publish.private,
            namespace: publish.namespace.clone(),
        };
        let host = publish.host.clone();
        match with_host(&hosting, &profiles, &host, "", move |c| {
            c.create_repository(&new)
        })
        .await
        {
            Err(e) => warning = Some(format!("Created here, but not on {host}: {e}")),
            Ok(created) => {
                let git = Git::new(&target).with_overrides(overrides);
                let (url, flag, progress) = (
                    created.https_url.clone(),
                    Arc::clone(&cancel),
                    on_progress.clone(),
                );
                let pushed = blocking(move || {
                    clone::publish(&git, &url, &flag, |l| {
                        let _ = progress.send(l.to_string());
                    })
                })
                .await;
                match pushed {
                    Ok(()) => published = Some(created.web_url),
                    Err(e) => {
                        warning = Some(format!(
                            "Created on {host} ({}), but pushing the first commit failed: {e}. Push again from the toolbar.",
                            created.web_url
                        ));
                    }
                }
            }
        }
    }
    end_op(&state, op_id, &cancel);

    let info = state.repos.open(&target)?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    folders.remember(&parent);
    Ok(CreateOutcome {
        info,
        published,
        warning,
    })
}
