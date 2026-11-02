use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use perseus_credentials::{Credential, SecretStore, validate};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::profiles::overrides::helper_path;

/// Non-secret half of a stored credential; the token itself is only in the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialMeta {
    pub host: String,
    pub username: String,
    /// True when the token came from an OAuth sign-in (and may renew itself).
    #[serde(default)]
    pub oauth: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    #[serde(default)]
    pub ssh_key: Option<String>,
    #[serde(default)]
    pub credentials: Vec<CredentialMeta>,
}

/// What the webview may send when creating or editing a profile.
#[derive(Debug, Deserialize)]
pub struct ProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    pub ssh_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfilesSnapshot {
    pub profiles: Vec<Profile>,
    pub active: Option<String>,
    /// False when the credential helper binary is missing next to the app.
    pub helper_available: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    profiles: Vec<Profile>,
    #[serde(default)]
    active: Option<String>,
}

/// Cheap to clone (shared state), so keychain work can move onto a blocking thread.
#[derive(Clone)]
pub struct ProfileStore {
    path: PathBuf,
    state: Arc<Mutex<State>>,
    secrets: Arc<dyn SecretStore + Send + Sync>,
}

fn text(field: &str, value: &str, max: usize) -> Result<String> {
    let v = value.trim();
    if !validate::is_plain_text(v) || v.chars().count() > max {
        return Err(AppError::profile(format!(
            "{field} must be 1-{max} characters with no control characters"
        )));
    }
    Ok(v.to_string())
}

fn email(value: &str) -> Result<String> {
    let v = text("email", value, 254)?;
    let ok = v
        .split_once('@')
        .is_some_and(|(l, d)| !l.is_empty() && d.contains('.') && !d.contains('@'))
        && !v.chars().any(char::is_whitespace);
    if ok {
        Ok(v)
    } else {
        Err(AppError::profile("email must look like name@host.tld"))
    }
}

fn ssh_key(value: Option<&str>) -> Result<Option<String>> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if !validate::is_plain_text(v) || !Path::new(v).is_file() {
        return Err(AppError::profile("SSH key file was not found"));
    }
    Ok(Some(v.to_string()))
}

impl ProfileStore {
    /// Loads `path`, treating a missing file as "no profiles". A file that cannot be
    /// parsed is moved aside rather than overwritten, so nothing is silently lost.
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore + Send + Sync>) -> Self {
        let state = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                State::default()
            }),
            Err(_) => State::default(),
        };
        Self {
            path,
            state: Arc::new(Mutex::new(state)),
            secrets,
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| AppError::Internal("profile store poisoned".into()))
    }

    fn persist(&self, state: &State) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(AppError::profile)?;
        }
        let json = serde_json::to_string_pretty(state).map_err(AppError::profile)?;
        // Write-then-rename so a crash never leaves a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(AppError::profile)?;
        std::fs::rename(&tmp, &self.path).map_err(AppError::profile)
    }

    /// The active profile's access token for `host`, renewed first when it has expired. Used by
    /// the hosting integrations; the token never leaves the backend.
    pub fn fresh_token(&self, host: &str) -> Result<Option<String>> {
        let Some(profile) = self.active() else {
            return Ok(None);
        };
        let http = perseus_credentials::http::UreqHttp::new();
        let refresher = perseus_credentials::refresh::Refresher {
            http: &http,
            lock_dir: perseus_credentials::refresh::default_lock_dir(),
            now: perseus_credentials::oauth::now_unix(),
        };
        let fresh = perseus_credentials::refresh::fresh_credential(
            &*self.secrets,
            &refresher,
            &profile.id,
            host,
        )
        .map_err(AppError::profile)?;
        Ok(fresh.credential.map(|c| c.token))
    }

    pub fn snapshot(&self) -> Result<ProfilesSnapshot> {
        let s = self.lock()?;
        Ok(ProfilesSnapshot {
            profiles: s.profiles.clone(),
            active: s.active.clone(),
            helper_available: helper_path().is_some(),
        })
    }

    pub fn active(&self) -> Option<Profile> {
        let s = self.state.lock().ok()?;
        let id = s.active.as_ref()?;
        s.profiles.iter().find(|p| &p.id == id).cloned()
    }

    pub fn save(&self, input: ProfileInput) -> Result<Profile> {
        let name = text("name", &input.name, 64)?;
        let user_name = text("commit name", &input.user_name, 100)?;
        let user_email = email(&input.user_email)?;
        let ssh_key = ssh_key(input.ssh_key.as_deref())?;

        let mut s = self.lock()?;
        let saved = match &input.id {
            Some(id) => {
                let p = s
                    .profiles
                    .iter_mut()
                    .find(|p| &p.id == id)
                    .ok_or_else(|| AppError::profile("profile no longer exists"))?;
                p.name = name;
                p.user_name = user_name;
                p.user_email = user_email;
                p.ssh_key = ssh_key;
                p.clone()
            }
            None => {
                let p = Profile {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name,
                    user_name,
                    user_email,
                    ssh_key,
                    credentials: Vec::new(),
                };
                s.profiles.push(p.clone());
                p
            }
        };
        self.persist(&s)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut s = self.lock()?;
        let profile = s
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::profile("profile no longer exists"))?;
        // Secrets first: if the keychain refuses, the profile stays and the user can retry.
        for c in &profile.credentials {
            self.secrets
                .delete(id, &c.host)
                .map_err(AppError::profile)?;
        }
        s.profiles.retain(|p| p.id != id);
        if s.active.as_deref() == Some(id) {
            s.active = None;
        }
        self.persist(&s)
    }

    pub fn set_active(&self, id: Option<&str>) -> Result<()> {
        let mut s = self.lock()?;
        if let Some(id) = id
            && !s.profiles.iter().any(|p| p.id == id)
        {
            return Err(AppError::profile("profile no longer exists"));
        }
        s.active = id.map(str::to_string);
        self.persist(&s)
    }

    /// A pasted token (personal access token, API token).
    pub fn set_credential(&self, id: &str, host: &str, username: &str, token: &str) -> Result<()> {
        let username = text("username", username, 100)?;
        // The token is validated as-is (no trimming): what the user pasted is what is stored.
        self.store_credential(id, host, Credential::new(username, token))
    }

    /// Tokens obtained by an OAuth sign-in, including their refresh state.
    pub fn set_oauth_credential(&self, id: &str, host: &str, cred: Credential) -> Result<()> {
        self.store_credential(id, host, cred)
    }

    fn store_credential(&self, id: &str, host: &str, cred: Credential) -> Result<()> {
        let host = validate::host(host)
            .ok_or_else(|| AppError::profile("host must be a plain hostname such as github.com"))?;
        let mut s = self.lock()?;
        let profile = s
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::profile("profile no longer exists"))?;

        self.secrets
            .set(id, &host, &cred)
            .map_err(AppError::profile)?;

        profile.credentials.retain(|c| c.host != host);
        profile.credentials.push(CredentialMeta {
            host,
            username: cred.username.clone(),
            oauth: cred.oauth.is_some(),
        });
        profile.credentials.sort_by(|a, b| a.host.cmp(&b.host));
        self.persist(&s)
    }

    pub fn remove_credential(&self, id: &str, host: &str) -> Result<()> {
        let host = validate::host(host).ok_or_else(|| AppError::profile("invalid host"))?;
        let mut s = self.lock()?;
        let profile = s
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::profile("profile no longer exists"))?;
        self.secrets.delete(id, &host).map_err(AppError::profile)?;
        profile.credentials.retain(|c| c.host != host);
        self.persist(&s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use perseus_credentials::MemoryStore;

    struct Fixture {
        dir: tempfile::TempDir,
        secrets: Arc<MemoryStore>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
                secrets: Arc::new(MemoryStore::default()),
            }
        }
        fn path(&self) -> PathBuf {
            self.dir.path().join("profiles.json")
        }
        fn store(&self) -> ProfileStore {
            ProfileStore::load(self.path(), self.secrets.clone())
        }
    }

    fn input(name: &str) -> ProfileInput {
        ProfileInput {
            id: None,
            name: name.into(),
            user_name: "Ada Lovelace".into(),
            user_email: "ada@example.com".into(),
            ssh_key: None,
        }
    }

    #[test]
    fn create_update_persist_and_reload() {
        let f = Fixture::new();
        let store = f.store();
        let work = store.save(input("Work")).unwrap();
        assert_eq!(work.id.len(), 32);

        store.set_active(Some(&work.id)).unwrap();
        let mut edit = input("Work (renamed)");
        edit.id = Some(work.id.clone());
        edit.user_email = "ada@corp.example".into();
        store.save(edit).unwrap();

        let reloaded = f.store();
        let snap = reloaded.snapshot().unwrap();
        assert_eq!(snap.profiles.len(), 1);
        assert_eq!(snap.profiles[0].name, "Work (renamed)");
        assert_eq!(snap.profiles[0].user_email, "ada@corp.example");
        assert_eq!(snap.active.as_deref(), Some(work.id.as_str()));
        assert_eq!(reloaded.active().unwrap().id, work.id);
    }

    #[test]
    fn tokens_go_to_the_secret_store_never_to_disk() {
        let f = Fixture::new();
        let store = f.store();
        let p = store.save(input("Personal")).unwrap();
        store
            .set_credential(&p.id, "GitHub.com", "ada", "ghp_TOPSECRET")
            .unwrap();

        let on_disk = std::fs::read_to_string(f.path()).unwrap();
        assert!(
            !on_disk.contains("TOPSECRET"),
            "token leaked to profiles.json"
        );
        assert!(on_disk.contains("github.com"));

        let cred = f.secrets.get(&p.id, "github.com").unwrap().unwrap();
        assert_eq!(
            (cred.username.as_str(), cred.token.as_str()),
            ("ada", "ghp_TOPSECRET")
        );

        // Re-saving the same host replaces rather than duplicates.
        store
            .set_credential(&p.id, "github.com", "ada", "ghp_NEW")
            .unwrap();
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.profiles[0].credentials.len(), 1);
        assert_eq!(
            f.secrets.get(&p.id, "github.com").unwrap().unwrap().token,
            "ghp_NEW"
        );

        store.remove_credential(&p.id, "github.com").unwrap();
        assert!(f.secrets.get(&p.id, "github.com").unwrap().is_none());
        assert!(store.snapshot().unwrap().profiles[0].credentials.is_empty());
    }

    #[test]
    fn profiles_cannot_see_each_others_tokens() {
        let f = Fixture::new();
        let store = f.store();
        let a = store.save(input("A")).unwrap();
        let b = store.save(input("B")).unwrap();
        store
            .set_credential(&a.id, "github.com", "a", "token-a")
            .unwrap();
        assert!(f.secrets.get(&b.id, "github.com").unwrap().is_none());
    }

    #[test]
    fn delete_removes_secrets_and_clears_active() {
        let f = Fixture::new();
        let store = f.store();
        let p = store.save(input("Temp")).unwrap();
        store
            .set_credential(&p.id, "gitlab.com", "ada", "tok")
            .unwrap();
        store.set_active(Some(&p.id)).unwrap();

        store.delete(&p.id).unwrap();
        assert!(f.secrets.get(&p.id, "gitlab.com").unwrap().is_none());
        let snap = store.snapshot().unwrap();
        assert!(snap.profiles.is_empty() && snap.active.is_none());
        assert!(store.delete(&p.id).is_err());
    }

    #[test]
    fn validation_rejects_hostile_or_malformed_input() {
        let f = Fixture::new();
        let store = f.store();
        let bad = |mutate: &dyn Fn(&mut ProfileInput)| {
            let mut i = input("ok");
            mutate(&mut i);
            assert!(store.save(i).is_err());
        };
        bad(&|i| i.name = "  ".into());
        bad(&|i| i.name = "x".repeat(65));
        bad(&|i| i.user_name = "Ada\nuser.email=evil".into());
        bad(&|i| i.user_email = "not-an-email".into());
        bad(&|i| i.user_email = "a@b@c.com".into());
        bad(&|i| i.user_email = "a b@c.com".into());
        bad(&|i| i.ssh_key = Some("C:/definitely/not/here".into()));
        bad(&|i| i.id = Some("deadbeef".into()));
        assert!(store.snapshot().unwrap().profiles.is_empty());

        let p = store.save(input("ok")).unwrap();
        assert!(
            store
                .set_credential(&p.id, "evil.com/path", "u", "t")
                .is_err()
        );
        assert!(
            store
                .set_credential(&p.id, "github.com", "u", "tok\nhost=evil")
                .is_err()
        );
        assert!(
            store
                .set_credential(&p.id, "github.com", "", "tok")
                .is_err()
        );
        assert!(
            store
                .set_credential("0".repeat(32).as_str(), "github.com", "u", "t")
                .is_err()
        );
        assert!(store.set_active(Some("nope")).is_err());
    }

    #[test]
    fn ssh_key_must_exist_and_is_stored_as_given() {
        let f = Fixture::new();
        let store = f.store();
        let key = f.dir.path().join("id_ed25519");
        std::fs::write(&key, "not a real key").unwrap();

        let mut i = input("Keyed");
        i.ssh_key = Some(key.to_string_lossy().into_owned());
        let p = store.save(i).unwrap();
        assert_eq!(p.ssh_key.as_deref(), Some(key.to_string_lossy().as_ref()));

        // Clearing the field removes the key.
        let mut again = input("Keyed");
        again.id = Some(p.id.clone());
        again.ssh_key = Some("   ".into());
        assert_eq!(store.save(again).unwrap().ssh_key, None);
    }

    #[test]
    fn a_corrupt_file_is_set_aside_not_overwritten() {
        let f = Fixture::new();
        std::fs::write(f.path(), "{ this is not json").unwrap();
        let store = f.store();
        assert!(store.snapshot().unwrap().profiles.is_empty());
        assert!(f.dir.path().join("profiles.json.corrupt").exists());

        store.save(input("Fresh")).unwrap();
        assert_eq!(f.store().snapshot().unwrap().profiles.len(), 1);
    }

    #[test]
    fn unknown_fields_and_missing_optional_fields_load() {
        let f = Fixture::new();
        std::fs::write(
            f.path(),
            r#"{"profiles":[{"id":"0123456789abcdef0123456789abcdef","name":"Old","user_name":"A","user_email":"a@b.co","future_field":1}]}"#,
        )
        .unwrap();
        let snap = f.store().snapshot().unwrap();
        assert_eq!(snap.profiles[0].credentials.len(), 0);
        assert!(snap.active.is_none());
    }
}
