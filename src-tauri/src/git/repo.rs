use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::error::{AppError, Result};

pub type RepoId = u32;

#[derive(Debug, Clone, Serialize)]
pub struct RepoInfo {
    pub id: RepoId,
    pub path: PathBuf,
    pub name: String,
}

/// Open repositories. The registry doubles as the workspace allowlist: the
/// webview only ever holds opaque `RepoId`s, and paths enter exclusively
/// through [`RepoRegistry::open`], which is reached from the native folder picker.
#[derive(Default)]
pub struct RepoRegistry {
    next_id: AtomicU32,
    repos: RwLock<HashMap<RepoId, (RepoInfo, Arc<gix::ThreadSafeRepository>)>>,
}

impl RepoRegistry {
    pub fn open(&self, path: &Path) -> Result<RepoInfo> {
        let repo = gix::ThreadSafeRepository::open(path).map_err(AppError::git)?;
        let root = repo
            .work_dir()
            .unwrap_or_else(|| repo.git_dir())
            .to_path_buf();
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        let info = RepoInfo {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            path: root,
            name,
        };
        self.repos
            .write()
            .map_err(|_| AppError::Internal("repo registry poisoned".into()))?
            .insert(info.id, (info.clone(), Arc::new(repo)));
        Ok(info)
    }

    pub fn get(&self, id: RepoId) -> Result<Arc<gix::ThreadSafeRepository>> {
        self.repos
            .read()
            .map_err(|_| AppError::Internal("repo registry poisoned".into()))?
            .get(&id)
            .map(|(_, r)| Arc::clone(r))
            .ok_or(AppError::UnknownRepo(id))
    }

    pub fn close(&self, id: RepoId) {
        if let Ok(mut repos) = self.repos.write() {
            repos.remove(&id);
        }
    }
}
