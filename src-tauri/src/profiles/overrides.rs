use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::git::cli::GitOverrides;
use crate::profiles::Profile;

/// Quotes `s` for a POSIX shell (git runs `GIT_SSH_COMMAND` and `!` credential
/// helpers through `sh`, including Git for Windows' bundled one). Single quotes
/// preserve every character literally except `'` itself.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Forward slashes work for git's sh and ssh on every platform, including Windows.
fn slashes(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// The credential helper binary lives next to the app executable.
pub fn helper_path() -> Option<PathBuf> {
    let name = format!("perseus-credential-helper{}", std::env::consts::EXE_SUFFIX);
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

impl Profile {
    /// Settings that make one git command act as this profile.
    ///
    /// * identity: `user.name` / `user.email` for commits, merges, rebases
    /// * SSH: only this profile's key is offered (`IdentitiesOnly`), and ssh never
    ///   waits on a prompt (`BatchMode`) that nobody could answer
    /// * HTTPS: if the profile holds tokens, other credential helpers are cleared and
    ///   the Perseus helper is the only one asked, so another profile's token (or a
    ///   system-wide login) can never be used by accident
    pub fn git_overrides(&self, helper: Option<&Path>) -> Result<GitOverrides> {
        let mut o = GitOverrides::default();
        o.config.push(("user.name".into(), self.user_name.clone()));
        o.config
            .push(("user.email".into(), self.user_email.clone()));
        o.env.push(("PERSEUS_PROFILE".into(), self.id.clone()));

        if let Some(key) = &self.ssh_key {
            let key = slashes(Path::new(key));
            if key.contains('\0') {
                return Err(AppError::Git("invalid SSH key path".into()));
            }
            o.env.push((
                "GIT_SSH_COMMAND".into(),
                format!(
                    "ssh -i {} -o IdentitiesOnly=yes -o BatchMode=yes",
                    shell_quote(&key)
                ),
            ));
        }

        if !self.credentials.is_empty()
            && let Some(helper) = helper
        {
            o.config.push(("credential.helper".into(), String::new()));
            o.config.push((
                "credential.helper".into(),
                format!("!{}", shell_quote(&slashes(helper))),
            ));
        }
        Ok(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::Git;
    use crate::git::cli::testutil::*;
    use crate::profiles::store::CredentialMeta;

    fn profile() -> Profile {
        Profile {
            id: "0123456789abcdef0123456789abcdef".into(),
            name: "Work".into(),
            user_name: "Ada Lovelace".into(),
            user_email: "ada@work.example".into(),
            ssh_key: None,
            credentials: vec![],
        }
    }

    #[test]
    fn identity_and_profile_env_always_present() {
        let o = profile().git_overrides(None).unwrap();
        assert!(
            o.config
                .contains(&("user.name".into(), "Ada Lovelace".into()))
        );
        assert!(
            o.config
                .contains(&("user.email".into(), "ada@work.example".into()))
        );
        assert!(o.env.contains(&("PERSEUS_PROFILE".into(), profile().id)));
        assert!(!o.config.iter().any(|(k, _)| k == "credential.helper"));
        assert!(!o.env.iter().any(|(k, _)| k == "GIT_SSH_COMMAND"));
    }

    #[test]
    fn helper_is_installed_only_when_the_profile_has_tokens() {
        let helper = Path::new("C:\\Program Files\\Perseus\\perseus-credential-helper.exe");
        let none = profile().git_overrides(Some(helper)).unwrap();
        assert!(!none.config.iter().any(|(k, _)| k == "credential.helper"));

        let mut p = profile();
        p.credentials.push(CredentialMeta {
            host: "github.com".into(),
            username: "ada".into(),
        });
        let o = p.git_overrides(Some(helper)).unwrap();
        let helpers: Vec<_> = o
            .config
            .iter()
            .filter(|(k, _)| k == "credential.helper")
            .map(|(_, v)| v.as_str())
            .collect();
        // First entry clears inherited helpers; second is ours, quoted for sh.
        assert_eq!(
            helpers,
            [
                "",
                "!'C:/Program Files/Perseus/perseus-credential-helper.exe'"
            ]
        );

        // Without a helper binary the profile still works for everything else.
        assert!(p.git_overrides(None).unwrap().config.len() == 2);
    }

    #[test]
    fn ssh_command_offers_only_the_profiles_key() {
        let mut p = profile();
        p.ssh_key = Some("C:\\Users\\Ada Lovelace\\.ssh\\id_work".into());
        let o = p.git_overrides(None).unwrap();
        let cmd = &o
            .env
            .iter()
            .find(|(k, _)| k == "GIT_SSH_COMMAND")
            .unwrap()
            .1;
        assert_eq!(
            cmd,
            "ssh -i 'C:/Users/Ada Lovelace/.ssh/id_work' -o IdentitiesOnly=yes -o BatchMode=yes"
        );
    }

    /// Round-trips awkward strings through the real shell git uses.
    #[test]
    fn shell_quote_survives_a_real_shell() {
        let git = Git::new(std::env::temp_dir());
        for s in [
            "plain",
            "with space",
            "it's",
            "'''",
            "$HOME `id` $(id) \"x\" ; echo pwned",
            "semi;colon && more",
            "C:/Program Files/x y/z",
            "ünïcode ✓",
        ] {
            let alias = format!("alias.q=!printf %s {}", shell_quote(s));
            let out = git.output(["-c", alias.as_str(), "q"]).unwrap();
            assert_eq!(String::from_utf8_lossy(&out), s, "mangled {s:?}");
        }
    }

    #[test]
    fn commits_carry_the_profile_identity_without_touching_config() {
        let (_d, base) = init_repo();
        let git = base
            .clone()
            .with_overrides(profile().git_overrides(None).unwrap());
        write(&git, "a.txt", "a\n");
        git.output(["add", "a.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "as profile"]).unwrap();

        let author = git
            .output(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&author).trim(),
            "Ada Lovelace <ada@work.example>|Ada Lovelace <ada@work.example>"
        );
        // The repository's own identity (set by init_repo) is untouched.
        let cfg = base.output(["config", "--local", "user.name"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&cfg).trim(), "Tester");
    }

    #[test]
    fn a_stale_inherited_profile_variable_is_scrubbed() {
        // Spawned git must not see PERSEUS_PROFILE unless an override sets it.
        // SAFETY: tests in this crate do not read this variable concurrently.
        unsafe { std::env::set_var("PERSEUS_PROFILE", "stale") };
        let git = Git::new(std::env::temp_dir());
        let out = git
            .output(["-c", "alias.e=!printf %s \"$PERSEUS_PROFILE\"", "e"])
            .unwrap();
        unsafe { std::env::remove_var("PERSEUS_PROFILE") };
        assert!(out.is_empty());

        let scoped =
            Git::new(std::env::temp_dir()).with_overrides(profile().git_overrides(None).unwrap());
        let out = scoped
            .output(["-c", "alias.e=!printf %s \"$PERSEUS_PROFILE\"", "e"])
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out), profile().id);
    }
}

/// The production composition end to end: ProfileStore -> git_overrides -> Git ->
/// real helper binary -> real OS keychain -> a local server that demands Basic auth.
/// Ignored by default (writes a temporary keychain entry); run with
/// `cargo build -p perseus-credential-helper && cargo test -p perseus -- --ignored profile_auth`.
#[cfg(test)]
mod profile_auth_flow {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use perseus_credentials::KeyringStore;

    use crate::git::cli::Git;
    use crate::profiles::{ProfileInput, ProfileStore};

    fn b64(input: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |a, (i, &b)| a | (b as u32) << (16 - 8 * i));
            for i in 0..4 {
                out.push(if i <= chunk.len() {
                    T[(n >> (18 - 6 * i) & 63) as usize] as char
                } else {
                    '='
                });
            }
        }
        out
    }

    #[test]
    #[ignore]
    fn profile_auth_reaches_the_server_through_the_helper() {
        // Dev layout: <target>/debug/deps/<test exe>, helper at <target>/debug/.
        let exe = std::env::current_exe().unwrap();
        let name = format!("perseus-credential-helper{}", std::env::consts::EXE_SUFFIX);
        let helper = exe.parent().unwrap().parent().unwrap().join(name);
        assert!(
            helper.is_file(),
            "build the helper first: {}",
            helper.display()
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let server = {
            let (seen, stop) = (seen.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let Ok((mut c, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    };
                    c.set_nonblocking(false).unwrap();
                    c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let (mut buf, mut chunk) = (Vec::new(), [0u8; 1024]);
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match c.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).into_owned();
                    let reply = match head.lines().find_map(|l| l.strip_prefix("Authorization: ")) {
                        Some(a) => {
                            seen.lock().unwrap().push(a.to_string());
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        }
                        None => {
                            "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        }
                    };
                    let _ = c.write_all(reply.as_bytes());
                }
            })
        };

        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::load(dir.path().join("profiles.json"), Arc::new(KeyringStore));
        let profile = store
            .save(ProfileInput {
                id: None,
                name: "Secondary".into(),
                user_name: "Ada Lovelace".into(),
                user_email: "ada@example.com".into(),
                ssh_key: None,
            })
            .unwrap();
        let host = format!("127.0.0.1:{port}");
        store
            .set_credential(&profile.id, &host, "ada", "tok-from-app")
            .unwrap();
        let profile = store.snapshot().unwrap().profiles.remove(0);

        let git =
            Git::new(dir.path()).with_overrides(profile.git_overrides(Some(&helper)).unwrap());
        // The server answers 404 after authenticating, so git itself reports failure.
        let result = git.output(["ls-remote", &format!("http://{host}/repo.git")]);

        stop.store(true, Ordering::Relaxed);
        server.join().unwrap();
        store.delete(&profile.id).unwrap(); // also removes the keychain entry

        assert!(result.is_err());
        let expected = format!("Basic {}", b64(b"ada:tok-from-app"));
        assert_eq!(*seen.lock().unwrap(), vec![expected]);
    }
}
