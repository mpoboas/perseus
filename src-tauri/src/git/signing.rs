//! Commit signing: generating an SSH key, and checking whether a commit's signature is good.
//!
//! Signing itself is configured per profile (`profiles/overrides.rs`): git signs with the
//! profile's key whenever that profile commits. Verification needs a list of keys to trust, built
//! from the profiles' own keys, so a commit signed by one of your profiles reads "good".

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    /// Valid signature from a trusted key.
    Good,
    /// The signature does not match the commit.
    Bad,
    /// A valid signature, but the key is not one Perseus knows.
    Unknown,
    /// The signature expired or its key was revoked.
    Expired,
    /// Not signed.
    None,
    /// Signed, but the check could not run (no `gpg` or `ssh-keygen`, unreadable key…).
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Signature {
    pub status: SignatureStatus,
    pub signer: Option<String>,
    pub key: Option<String>,
}

/// A trusted SSH key: the e-mail it signs for and the public key line (`ssh-ed25519 AAAA…`).
pub struct Signer {
    pub email: String,
    pub public_key: String,
}

fn status_of(code: char) -> SignatureStatus {
    match code {
        'G' => SignatureStatus::Good,
        'B' | 'R' => SignatureStatus::Bad,
        'U' => SignatureStatus::Unknown,
        'X' | 'Y' => SignatureStatus::Expired,
        'N' => SignatureStatus::None,
        _ => SignatureStatus::Error,
    }
}

/// Reads the signature state of one commit.
pub fn signature(git: &Git, oid: &str, signers: &[Signer]) -> Result<Signature> {
    let oid = validate::oid(oid)?.to_string();
    // The allowed-signers file lives only for this call.
    let file = if signers.is_empty() {
        None
    } else {
        let path = std::env::temp_dir().join(format!("perseus-signers-{}", uuid::Uuid::new_v4()));
        let mut text = String::new();
        for s in signers {
            // `email namespaces="git" key`: restricts the key to git signatures.
            let key = s.public_key.trim().replace(['\r', '\n'], " ");
            let email = s.email.replace([' ', '\r', '\n'], "");
            text.push_str(&format!("{email} namespaces=\"git\" {key}\n"));
        }
        std::fs::write(&path, text).map_err(AppError::git)?;
        Some(path)
    };

    let mut args: Vec<String> = Vec::new();
    if let Some((k, v)) = ssh_program_config() {
        args.push("-c".into());
        args.push(format!("{k}={v}"));
    }
    if let Some(p) = &file {
        args.push("-c".into());
        args.push(format!(
            "gpg.ssh.allowedSignersFile={}",
            p.to_string_lossy().replace('\\', "/")
        ));
    }
    args.extend(["log", "-1", "--format=%G?%x00%GS%x00%GK"].map(String::from));
    args.push(oid);
    let out = git.output(args);
    if let Some(p) = file {
        let _ = std::fs::remove_file(p);
    }
    let out = out?;
    let text = String::from_utf8_lossy(&out);
    let mut f = text.trim_end().split('\0');
    let code = f.next().and_then(|c| c.chars().next()).unwrap_or('N');
    let non_empty = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Ok(Signature {
        status: status_of(code),
        signer: non_empty(f.next()),
        key: non_empty(f.next()),
    })
}

/// `ssh-keygen`: on `PATH`, or the copy that ships with Git for Windows (which is not on `PATH`).
pub fn find_ssh_keygen() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    };
    if let Some(path) = std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(name))
            .find(|c| c.is_file())
    }) {
        return Some(path);
    }
    // Git for Windows: <git>/mingw64/libexec/git-core -> <git>/usr/bin
    let out = std::process::Command::new("git")
        .arg("--exec-path")
        .output()
        .ok()?;
    let exec = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    exec.ancestors()
        .nth(3)
        .map(|root| root.join("usr").join("bin").join(name))
        .filter(|p| p.is_file())
}

/// `-c gpg.ssh.program=<ssh-keygen>` for the places where git must run it to sign or verify.
pub fn ssh_program_config() -> Option<(String, String)> {
    find_ssh_keygen().map(|p| {
        (
            "gpg.ssh.program".to_string(),
            p.to_string_lossy().replace('\\', "/"),
        )
    })
}

pub struct NewKey {
    /// Private key file (never shown; only its path is stored in the profile).
    pub path: PathBuf,
    /// The public half, to paste into GitHub, GitLab or an allowed-signers list.
    pub public_key: String,
}

/// Creates an ed25519 key pair in `dir`, named after `label`. An existing file is never overwritten.
/// The key has no passphrase; the profile's prompts and the OS file permissions protect it.
pub fn generate_key(dir: &Path, label: &str, comment: &str) -> Result<NewKey> {
    let name: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('-');
    let name = if name.is_empty() { "key" } else { name };
    if comment.contains(['\n', '\r', '\0']) {
        return Err(AppError::Git("invalid key comment".into()));
    }
    let keygen = find_ssh_keygen().ok_or_else(|| {
        AppError::Git("ssh-keygen was not found; install OpenSSH or Git for Windows".into())
    })?;
    std::fs::create_dir_all(dir).map_err(AppError::git)?;
    let path = dir.join(format!("perseus_{name}_ed25519"));
    if path.exists() || path.with_extension("pub").exists() {
        return Err(AppError::Git(format!(
            "a key named {} already exists",
            path.display()
        )));
    }
    let mut cmd = std::process::Command::new(keygen);
    cmd.args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"])
        .arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(AppError::git)?;
    if !out.status.success() {
        return Err(AppError::Git(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let public_key = std::fs::read_to_string(path.with_file_name(format!(
        "{}.pub",
        path.file_name().unwrap_or_default().to_string_lossy()
    )))
    .map_err(AppError::git)?
    .trim()
    .to_string();
    Ok(NewKey { path, public_key })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn signing_git(git: &Git, key: &Path) -> Git {
        let (program_key, program) = ssh_program_config().expect("ssh-keygen is available");
        // `with_config` keeps the runner's other settings (the tests' isolation from the user's own configuration).
        git.clone()
            .with_config(&program_key, &program)
            .with_config("gpg.format", "ssh")
            .with_config("user.signingkey", &key.to_string_lossy().replace('\\', "/"))
            .with_config("commit.gpgsign", "true")
    }

    #[test]
    fn a_signed_commit_verifies_only_against_the_right_key() {
        let (d, git) = init_repo();
        let Some(_) = find_ssh_keygen() else {
            eprintln!("skipping: ssh-keygen not available");
            return;
        };
        let keys = d.path().join("keys-outside-repo");
        let key = generate_key(&keys, "Work", "work key").unwrap();
        assert!(key.public_key.starts_with("ssh-ed25519 "));

        write(&git, "a.txt", "a\n");
        git.output(["add", "a.txt"]).unwrap();
        signing_git(&git, &key.path)
            .output(["commit", "-q", "-m", "signed"])
            .unwrap();
        let oid = String::from_utf8_lossy(&git.output(["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string();

        let good = signature(
            &git,
            &oid,
            &[Signer {
                email: "tester@example.com".into(),
                public_key: key.public_key.clone(),
            }],
        )
        .unwrap();
        assert_eq!(good.status, SignatureStatus::Good, "{good:?}");
        assert_eq!(good.signer.as_deref(), Some("tester@example.com"));

        // A different trusted key does not vouch for this commit.
        let other = generate_key(&keys, "Other", "other").unwrap();
        let wrong = signature(
            &git,
            &oid,
            &[Signer {
                email: "tester@example.com".into(),
                public_key: other.public_key,
            }],
        )
        .unwrap();
        assert_ne!(wrong.status, SignatureStatus::Good, "{wrong:?}");

        // An unsigned commit says so.
        write(&git, "b.txt", "b\n");
        git.output(["add", "b.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "plain"]).unwrap();
        let plain = String::from_utf8_lossy(&git.output(["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_string();
        assert_eq!(
            signature(&git, &plain, &[]).unwrap().status,
            SignatureStatus::None
        );
    }

    #[test]
    fn keys_are_never_overwritten_and_labels_are_sanitised() {
        let (d, _git) = init_repo();
        if find_ssh_keygen().is_none() {
            return;
        }
        let dir = d.path().join("k");
        let first = generate_key(&dir, "../../evil name", "c").unwrap();
        assert!(first.path.starts_with(&dir), "{:?}", first.path);
        assert!(
            first
                .path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("perseus_")
        );
        assert!(
            generate_key(&dir, "../../evil name", "c").is_err(),
            "no overwrite"
        );
        assert!(generate_key(&dir, "ok", "line\nbreak").is_err());
    }

    #[test]
    fn hostile_ids_are_rejected_and_status_codes_map() {
        let (_d, git) = init_repo();
        assert!(signature(&git, "--all", &[]).is_err());
        assert_eq!(status_of('G'), SignatureStatus::Good);
        assert_eq!(status_of('B'), SignatureStatus::Bad);
        assert_eq!(status_of('U'), SignatureStatus::Unknown);
        assert_eq!(status_of('N'), SignatureStatus::None);
        assert_eq!(status_of('E'), SignatureStatus::Error);
    }
}
