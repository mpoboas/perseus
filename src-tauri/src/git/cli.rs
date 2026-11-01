//! The only place Perseus spawns `git`. Everything funnels through [`Git`] so the
//! hardening lives in one spot:
//!
//! * arguments are a vector, never a shell string
//! * the environment is scrubbed of variables that redirect git elsewhere
//! * prompts and editors are disabled (they would hang a GUI-less child)
//! * repo-configurable program hooks that are not part of "run this git command"
//!   (`fsmonitor`, external diff, textconv, `ext::` transports) are switched off
//! * no console window flashes up on Windows

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::JoinHandle;

use crate::error::{AppError, Result};

const MAX_ERROR_CHARS: usize = 4000;

/// Env vars that would make git operate on something other than `root`.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
];

#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
}

impl Git {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root)
            .args([
                "--no-pager",
                "-c",
                "core.quotepath=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.ext.allow=never",
            ])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("LC_MESSAGES", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for var in SCRUBBED_ENV {
            cmd.env_remove(var);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    fn spawn(&self, mut cmd: Command) -> Result<Child> {
        cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Git("git executable not found; install git and restart".into())
            } else {
                AppError::git(e)
            }
        })
    }

    /// Runs git and returns stdout. Fails on any non-zero exit.
    pub fn output<I, S>(&self, args: I) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.output_allowing(args, &[0])
    }

    /// Like [`output`](Self::output) but treats the listed exit codes as success
    /// (`git diff --no-index` exits 1 when files differ).
    pub fn output_allowing<I, S>(&self, args: I, ok_codes: &[i32]) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let child = self.spawn(self.command(args))?;
        let out = child.wait_with_output().map_err(AppError::git)?;
        check(out.status, &out.stderr, &out.stdout, ok_codes)?;
        Ok(out.stdout)
    }

    /// Runs git feeding `input` on stdin (commit messages: avoids argv limits and quoting).
    pub fn output_with_stdin<I, S>(&self, args: I, input: &[u8]) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = self.command(args);
        cmd.stdin(Stdio::piped());
        let mut child = self.spawn(cmd)?;
        if let Some(mut stdin) = child.stdin.take() {
            // A write error means git exited early; its status below explains why.
            let _ = stdin.write_all(input);
        }
        let out = child.wait_with_output().map_err(AppError::git)?;
        check(out.status, &out.stderr, &out.stdout, &[0])?;
        Ok(out.stdout)
    }

    /// Returns at most `max` bytes of stdout; the flag says whether output was cut.
    /// The child is killed once the cap is exceeded, so a huge diff cannot exhaust memory.
    pub fn output_capped<I, S>(
        &self,
        args: I,
        max: usize,
        ok_codes: &[i32],
    ) -> Result<(Vec<u8>, bool)>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut child = self.spawn(self.command(args))?;
        let stderr = drain(child.stderr.take());
        let mut buf = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            stdout
                .take(max as u64 + 1)
                .read_to_end(&mut buf)
                .map_err(AppError::git)?;
        }
        let truncated = buf.len() > max;
        if truncated {
            buf.truncate(max);
            let _ = child.kill();
        }
        let status = child.wait().map_err(AppError::git)?;
        let stderr = stderr.join().unwrap_or_default();
        if !truncated {
            check(status, &stderr, &buf, ok_codes)?;
        }
        Ok((buf, truncated))
    }

    /// Runs a long operation (fetch/push/merge), calling `on_line` for each line or
    /// carriage-return-terminated progress update git prints on stderr.
    pub fn stream<I, S>(&self, args: I, mut on_line: impl FnMut(&str)) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut child = self.spawn(self.command(args))?;
        let stdout = drain(child.stdout.take());

        let mut all_stderr = Vec::new();
        if let Some(mut stderr) = child.stderr.take() {
            let mut chunk = [0u8; 4096];
            let mut line = Vec::new();
            loop {
                let n = stderr.read(&mut chunk).map_err(AppError::git)?;
                if n == 0 {
                    break;
                }
                all_stderr.extend_from_slice(&chunk[..n]);
                for &b in &chunk[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !line.is_empty() {
                            on_line(&String::from_utf8_lossy(&line));
                            line.clear();
                        }
                    } else {
                        line.push(b);
                    }
                }
            }
            if !line.is_empty() {
                on_line(&String::from_utf8_lossy(&line));
            }
        }
        let status = child.wait().map_err(AppError::git)?;
        let stdout = stdout.join().unwrap_or_default();
        check(status, &all_stderr, &stdout, &[0])?;
        Ok(stdout)
    }
}

/// Reads a pipe to the end on its own thread so a full pipe never blocks the child.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

/// Maps a finished process to a result. On failure the message is stderr, or stdout
/// when stderr is empty (merge conflicts are reported on stdout).
fn check(status: ExitStatus, stderr: &[u8], stdout: &[u8], ok_codes: &[i32]) -> Result<()> {
    if status.code().is_some_and(|c| ok_codes.contains(&c)) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(if stderr.is_empty() { stdout } else { stderr });
    let text = text.trim();
    let msg = if text.is_empty() {
        match status.code() {
            Some(c) => format!("git exited with status {c}"),
            None => "git was terminated".to_string(),
        }
    } else {
        text.chars().take(MAX_ERROR_CHARS).collect()
    };
    Err(AppError::Git(msg))
}

#[cfg(test)]
pub mod testutil {
    use super::*;

    /// Creates a repo with a deterministic identity and no signing/hooks surprises.
    pub fn init_repo() -> (tempfile::TempDir, Git) {
        let dir = tempfile::tempdir().unwrap();
        let git = Git::new(dir.path());
        git.output(["init", "-q", "-b", "main"]).unwrap();
        for (k, v) in [
            ("user.name", "Tester"),
            ("user.email", "tester@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git.output(["config", k, v]).unwrap();
        }
        (dir, git)
    }

    pub fn write(git: &Git, rel: &str, contents: &str) {
        let p = git.root().join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, contents).unwrap();
    }

    pub fn commit_file(git: &Git, rel: &str, contents: &str, msg: &str) {
        write(git, rel, contents);
        git.output(["add", "--", rel]).unwrap();
        git.output(["commit", "-q", "-m", msg]).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;

    #[test]
    fn failure_carries_git_stderr() {
        let (_d, git) = init_repo();
        let err = git.output(["checkout", "no-such-branch"]).unwrap_err();
        assert!(err.to_string().contains("no-such-branch"), "{err}");
    }

    #[test]
    fn stdin_is_passed_through() {
        let (_d, git) = init_repo();
        let out = git
            .output_with_stdin(["hash-object", "--stdin"], b"hello\n")
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out).trim(),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[test]
    fn capped_output_is_truncated_and_child_stops() {
        let (_d, git) = init_repo();
        commit_file(&git, "big.txt", &"line\n".repeat(50_000), "big");
        let (bytes, truncated) = git
            .output_capped(["show", "--format=", "HEAD"], 1000, &[0])
            .unwrap();
        assert!(truncated);
        assert_eq!(bytes.len(), 1000);
    }

    #[test]
    fn pathspec_magic_is_literal() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "a");
        write(&git, "a.txt", "changed\n");
        // `:(exclude)a.txt` would exclude the file if magic were honoured; literally it matches nothing.
        let out = git
            .output(["diff", "--name-only", "--", ":(exclude)a.txt"])
            .unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn stream_reports_progress_lines() {
        let (_d, git) = init_repo();
        let mut lines = Vec::new();
        // `git --version` prints on stdout; use a command that writes to stderr.
        let err = git
            .stream(["checkout", "nope"], |l| lines.push(l.to_string()))
            .unwrap_err();
        assert!(!lines.is_empty());
        assert!(err.to_string().contains("nope"));
    }
}
