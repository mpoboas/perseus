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

/// Longest alias accepted, in characters.
const MAX_ALIAS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recent {
    pub path: String,
    pub name: String,
    /// Unix seconds.
    pub last_opened: u64,
    /// Favorites stay in the list however long ago they were opened.
    #[serde(default)]
    pub favorite: bool,
    /// A name of the user's own, shown instead of the folder name.
    #[serde(default)]
    pub alias: Option<String>,
}

/// What the UI sees: the entry plus whether the folder still exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentView {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
    pub exists: bool,
    pub favorite: bool,
    pub alias: Option<String>,
}

/// An alias as stored: trimmed, with no control characters, at most [`MAX_ALIAS`] characters;
/// blank means "no alias".
fn clean_alias(alias: Option<&str>) -> Result<Option<String>> {
    let Some(alias) = alias.map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(None);
    };
    if alias.chars().any(char::is_control) {
        return Err(AppError::Git(
            "a name cannot contain control characters".into(),
        ));
    }
    if alias.chars().count() > MAX_ALIAS {
        return Err(AppError::Git(format!(
            "a name can have at most {MAX_ALIAS} characters"
        )));
    }
    Ok(Some(alias.to_string()))
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
                favorite: r.favorite,
                alias: r.alias,
            })
            .collect())
    }

    pub fn contains(&self, path: &str) -> bool {
        self.lock().is_ok_and(|i| i.iter().any(|r| r.path == path))
    }

    /// Records that `path` was just opened (adding it, or moving it to the top). A favorite mark
    /// and an alias survive being opened again.
    pub fn touch(&self, path: &str, name: &str) -> Result<()> {
        let mut items = self.lock()?;
        let before = items.iter().find(|r| r.path == path).cloned();
        items.retain(|r| r.path != path);
        items.push(Recent {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: now(),
            favorite: before.as_ref().is_some_and(|b| b.favorite),
            alias: before.and_then(|b| b.alias),
        });
        items.sort_by_key(|r| std::cmp::Reverse(r.last_opened));
        // Only the plain recents are capped: a favorite is never pushed out by newer ones.
        let mut plain = 0;
        items.retain(|r| {
            if r.favorite {
                return true;
            }
            plain += 1;
            plain <= MAX_RECENTS
        });
        self.persist(&items)
    }

    fn update(&self, path: &str, change: impl FnOnce(&mut Recent)) -> Result<()> {
        let mut items = self.lock()?;
        let item = items
            .iter_mut()
            .find(|r| r.path == path)
            .ok_or_else(|| AppError::Git("that repository is not in your list".into()))?;
        change(item);
        self.persist(&items)
    }

    /// Marks or unmarks a repository as a favorite.
    pub fn set_favorite(&self, path: &str, favorite: bool) -> Result<()> {
        self.update(path, |r| r.favorite = favorite)
    }

    /// Gives a repository a name of the user's own (blank clears it).
    pub fn set_alias(&self, path: &str, alias: Option<&str>) -> Result<()> {
        let alias = clean_alias(alias)?;
        self.update(path, |r| r.alias = alias)
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
    fn favorites_and_aliases_survive_reopening_and_restarts() {
        let (dir, s) = store();
        s.touch("p1", "one").unwrap();
        s.set_favorite("p1", true).unwrap();
        s.set_alias("p1", Some("  Work project  ")).unwrap();
        s.touch("p1", "one").unwrap(); // opened again

        let reloaded = RecentStore::load(dir.path().join("recents.json"));
        let list = reloaded.list().unwrap();
        assert!(list[0].favorite);
        assert_eq!(list[0].alias.as_deref(), Some("Work project"));
        assert_eq!(
            list[0].name, "one",
            "the folder name is kept next to the alias"
        );

        s.set_alias("p1", Some("   ")).unwrap();
        s.set_favorite("p1", false).unwrap();
        let list = s.list().unwrap();
        assert!(!list[0].favorite);
        assert_eq!(list[0].alias, None);
    }

    #[test]
    fn favorites_are_not_pushed_out_by_newer_repositories() {
        let (_d, s) = store();
        s.touch("old-favorite", "fav").unwrap();
        s.set_favorite("old-favorite", true).unwrap();
        for i in 0..(MAX_RECENTS + 5) {
            s.touch(&format!("repo-{i}"), "r").unwrap();
        }
        let list = s.list().unwrap();
        assert!(list.iter().any(|r| r.path == "old-favorite"));
        assert_eq!(list.iter().filter(|r| !r.favorite).count(), MAX_RECENTS);
    }

    #[test]
    fn marking_or_naming_an_unknown_path_is_refused() {
        let (_d, s) = store();
        assert!(s.set_favorite("C:/never/opened", true).is_err());
        assert!(s.set_alias("C:/never/opened", Some("x")).is_err());
        assert!(
            !s.contains("C:/never/opened"),
            "and it must not add the path"
        );
    }

    #[test]
    fn aliases_are_validated() {
        let (_d, s) = store();
        s.touch("p", "n").unwrap();
        assert!(s.set_alias("p", Some("line\nbreak")).is_err());
        assert!(s.set_alias("p", Some(&"x".repeat(MAX_ALIAS + 1))).is_err());
        assert!(s.set_alias("p", Some(&"x".repeat(MAX_ALIAS))).is_ok());
    }

    #[test]
    fn files_written_before_favorites_existed_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recents.json");
        std::fs::write(&file, r#"[{"path":"p","name":"n","last_opened":5}]"#).unwrap();
        let list = RecentStore::load(file).list().unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].favorite);
        assert_eq!(list[0].alias, None);
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
