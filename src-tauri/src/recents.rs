//! Recently opened repositories, shown on the welcome screen.
//!
//! The list lives in the app data directory. Opening from it is restricted to paths that
//! are already in the list (which only the native folder picker can add), so the webview
//! can never ask the backend to open an arbitrary directory.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

const MAX_RECENTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recent {
    pub path: String,
    pub name: String,
    /// Unix seconds.
    pub last_opened: u64,
}

/// What the UI sees: the entry plus whether the folder still exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentView {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
    pub exists: bool,
}

#[derive(Clone)]
pub struct RecentStore {
    file: PathBuf,
    items: Arc<Mutex<Vec<Recent>>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl RecentStore {
    /// A missing or unreadable file means "no recents"; it is never an error to start.
    pub fn load(file: PathBuf) -> Self {
        let items = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<Recent>>(&t).ok())
            .unwrap_or_default();
        Self {
            file,
            items: Arc::new(Mutex::new(items)),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Vec<Recent>>> {
        self.items
            .lock()
            .map_err(|_| AppError::Internal("recents poisoned".into()))
    }

    fn persist(&self, items: &[Recent]) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(AppError::git)?;
        }
        let json = serde_json::to_string_pretty(items).map_err(AppError::git)?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(AppError::git)?;
        std::fs::rename(&tmp, &self.file).map_err(AppError::git)
    }

    /// Newest first.
    pub fn list(&self) -> Result<Vec<RecentView>> {
        let mut items = self.lock()?.clone();
        items.sort_by_key(|r| std::cmp::Reverse(r.last_opened));
        Ok(items
            .into_iter()
            .map(|r| RecentView {
                exists: Path::new(&r.path).is_dir(),
                path: r.path,
                name: r.name,
                last_opened: r.last_opened,
            })
            .collect())
    }

    pub fn contains(&self, path: &str) -> bool {
        self.lock().is_ok_and(|i| i.iter().any(|r| r.path == path))
    }

    /// Records that `path` was just opened (adding it, or moving it to the top).
    pub fn touch(&self, path: &str, name: &str) -> Result<()> {
        let mut items = self.lock()?;
        items.retain(|r| r.path != path);
        items.push(Recent {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: now(),
        });
        items.sort_by_key(|r| std::cmp::Reverse(r.last_opened));
        items.truncate(MAX_RECENTS);
        self.persist(&items)
    }

    pub fn remove(&self, path: &str) -> Result<()> {
        let mut items = self.lock()?;
        items.retain(|r| r.path != path);
        self.persist(&items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, RecentStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = RecentStore::load(dir.path().join("recents.json"));
        (dir, store)
    }

    #[test]
    fn touch_orders_newest_first_and_deduplicates() {
        let (dir, s) = store();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let (a, b) = (
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        );

        s.touch(&a, "a").unwrap();
        s.touch(&b, "b").unwrap();
        s.touch(&a, "a").unwrap(); // re-opening moves it back to the top

        let list = s.list().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|r| r.exists));
        assert_eq!(list.iter().filter(|r| r.path == a).count(), 1);
        assert!(list[0].last_opened >= list[1].last_opened);
    }

    #[test]
    fn contains_only_known_paths() {
        let (_d, s) = store();
        s.touch("C:/repos/known", "known").unwrap();
        assert!(s.contains("C:/repos/known"));
        assert!(!s.contains("C:/repos/other"));
        assert!(!s.contains("C:/repos/known/../../Windows"));
        assert!(!s.contains(""));
    }

    #[test]
    fn missing_folders_are_reported_not_hidden() {
        let (_d, s) = store();
        s.touch("Z:/definitely/not/here", "gone").unwrap();
        let list = s.list().unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].exists);
    }

    #[test]
    fn persists_across_loads_and_removal_sticks() {
        let (dir, s) = store();
        s.touch("p1", "one").unwrap();
        s.touch("p2", "two").unwrap();
        s.remove("p1").unwrap();

        let reloaded = RecentStore::load(dir.path().join("recents.json"));
        let names: Vec<_> = reloaded
            .list()
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, ["two"]);
    }

    #[test]
    fn list_is_capped() {
        let (_d, s) = store();
        for i in 0..(MAX_RECENTS + 7) {
            s.touch(&format!("repo-{i}"), "r").unwrap();
        }
        assert_eq!(s.list().unwrap().len(), MAX_RECENTS);
    }

    #[test]
    fn a_corrupt_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recents.json");
        std::fs::write(&file, "{ nope").unwrap();
        let s = RecentStore::load(file);
        assert!(s.list().unwrap().is_empty());
        s.touch("p", "n").unwrap(); // and it recovers on the next write
        assert_eq!(s.list().unwrap().len(), 1);
    }
}
