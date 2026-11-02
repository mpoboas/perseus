use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::git::graph::{self, CommitRow, DEFAULT_CHUNK_SIZE, WalkSummary};
use crate::git::repo::{RepoId, RepoInfo, RepoRegistry};
use crate::recents::RecentStore;
use crate::watcher::Watch;

#[derive(Default)]
pub struct AppState {
    pub repos: RepoRegistry,
    /// Cancellation flags for in-flight streams, keyed by the frontend-chosen stream id.
    streams: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// Cancellation flags for running git operations, keyed by the frontend-chosen op id.
    pub ops: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// Active repository watches, keyed by the frontend-chosen watch id.
    pub watches: Mutex<HashMap<u32, Watch>>,
}

impl AppState {
    fn register_stream(&self, id: u32) -> Result<StreamGuard<'_>> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| AppError::Internal("stream registry poisoned".into()))?;
        // A reused id supersedes (and cancels) the earlier stream.
        if let Some(old) = streams.insert(id, Arc::clone(&flag)) {
            old.store(true, Ordering::Relaxed);
        }
        Ok(StreamGuard {
            state: self,
            id,
            flag,
        })
    }
}

struct StreamGuard<'a> {
    state: &'a AppState,
    id: u32,
    flag: Arc<AtomicBool>,
}

impl Drop for StreamGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.state.streams.lock() {
            // Only remove our own entry; a newer stream may have reused the id.
            if streams
                .get(&self.id)
                .is_some_and(|f| Arc::ptr_eq(f, &self.flag))
            {
                streams.remove(&self.id);
            }
        }
    }
}

#[derive(Serialize, Clone)]
pub struct CommitChunk {
    pub seq: u32,
    pub rows: Vec<CommitRow>,
}

/// Opens a native folder picker and registers the chosen repository. The path
/// never comes from the webview, so the frontend cannot point us at arbitrary
/// directories.
#[tauri::command]
pub async fn pick_and_open_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    recents: State<'_, RecentStore>,
) -> Result<Option<RepoInfo>> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let info = state.repos.open(&path)?;
    recents.touch(&info.path.to_string_lossy(), &info.name)?;
    Ok(Some(info))
}

#[tauri::command]
pub fn close_repo(state: State<'_, AppState>, repo_id: RepoId) {
    state.repos.close(repo_id);
}

/// Streams the commit history in topological order as chunks over `on_chunk`.
/// Resolves with a summary once the walk finishes or is cancelled.
#[tauri::command]
pub async fn stream_commits(
    state: State<'_, AppState>,
    repo_id: RepoId,
    stream_id: u32,
    on_chunk: Channel<CommitChunk>,
) -> Result<WalkSummary> {
    let repo = state.repos.get(repo_id)?;
    let git = state.repos.git(repo_id)?;
    let guard = state.register_stream(stream_id)?;
    let flag = Arc::clone(&guard.flag);

    // gix is synchronous and CPU/IO bound: keep it off the async executor.
    let result = tauri::async_runtime::spawn_blocking(move || {
        graph::ensure_commit_graph(&git);
        let repo = repo.to_thread_local();
        let mut seq = 0;
        graph::walk_commits(&repo, DEFAULT_CHUNK_SIZE, &flag, |rows| {
            let ok = on_chunk.send(CommitChunk { seq, rows }).is_ok();
            seq += 1;
            ok
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    drop(guard);
    result
}

#[tauri::command]
pub fn cancel_stream(state: State<'_, AppState>, stream_id: u32) {
    if let Ok(streams) = state.streams.lock()
        && let Some(flag) = streams.get(&stream_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}
