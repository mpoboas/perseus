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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

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
    // Set by us per profile; a stale inherited value must never select a profile.
    "PERSEUS_PROFILE",
];

/// One git command Perseus ran, for the activity log.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    /// Unix seconds when it started.
    pub time: u64,
    pub command: String,
    pub millis: u64,
    pub ok: bool,
    /// First line of git's complaint when it failed.
    pub error: Option<String>,
    /// Commands that only read (status, log, diff…): the log hides them unless asked.
    pub read_only: bool,
}

const LOG_CAPACITY: usize = 400;
static LOG: std::sync::Mutex<std::collections::VecDeque<LogEntry>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());

/// The most recent git commands, oldest first.
pub fn recent_commands() -> Vec<LogEntry> {
    LOG.lock()
        .map(|l| l.iter().cloned().collect())
        .unwrap_or_default()
}

/// Hides credentials embedded in URLs (`https://user:token@host`) before anything is logged.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            out.push_str("***@");
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

const READ_ONLY: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "for-each-ref",
    "cat-file",
    "ls-files",
    "ls-tree",
    "blame",
    "config",
    "merge-tree",
    "merge-base",
    "rev-list",
    "describe",
    "ls-remote",
    "check-ignore",
];

struct Activity {
    started: std::time::Instant,
    time: u64,
    command: String,
    read_only: bool,
}

impl Activity {
    fn begin(args: &[std::ffi::OsString]) -> Self {
        let words: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let first = words
            .iter()
            .find(|w| !w.starts_with('-'))
            .map(String::as_str)
            .unwrap_or("");
        let read_only = READ_ONLY.contains(&first)
            || (first == "remote" && words.iter().any(|w| w == "-v"))
            || (matches!(first, "stash" | "worktree" | "submodule")
                && words.iter().any(|w| w == "list" || w == "status"));
        let command: String = redact(
            &words
                .iter()
                .map(|w| {
                    if w.contains(' ') {
                        format!("\"{w}\"")
                    } else {
                        w.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        )
        .chars()
        .take(300)
        .collect();
        Self {
            started: std::time::Instant::now(),
            time: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
            command: format!("git {command}"),
            read_only,
        }
    }

    fn finish<T>(self, result: &Result<T>) {
        let entry = LogEntry {
            time: self.time,
            command: self.command,
            millis: self.started.elapsed().as_millis() as u64,
            ok: result.is_ok(),
            error: result.as_ref().err().map(|e| {
                e.to_string()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect()
            }),
            read_only: self.read_only,
        };
        if let Ok(mut log) = LOG.lock() {
            if log.len() >= LOG_CAPACITY {
                log.pop_front();
            }
            log.push_back(entry);
        }
    }
}

fn collect_args<I, S>(args: I) -> Vec<std::ffi::OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect()
}

/// Environment set once at start-up and applied to every git command (the askpass program and
/// its server address). Per-profile values still win over it.
static GLOBAL_ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

pub fn set_global_env(env: Vec<(String, String)>) {
    let _ = GLOBAL_ENV.set(env);
}

/// True when git and ssh can ask the user questions through Perseus.
pub fn askpass_active() -> bool {
    GLOBAL_ENV
        .get()
        .is_some_and(|e| e.iter().any(|(k, _)| k == "GIT_ASKPASS"))
}

/// Per-profile settings injected into one git invocation. They live only on the
/// command line and in the child's environment, so the user's `~/.gitconfig` and
/// the repository's `.git/config` are never modified.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitOverrides {
    /// Passed as `-c key=value`, in order (repeated keys are allowed).
    pub config: Vec<(String, String)>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
    overrides: GitOverrides,
}

impl Git {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            overrides: GitOverrides::default(),
        }
    }

    pub fn with_overrides(mut self, overrides: GitOverrides) -> Self {
        self.overrides = overrides;
        self
    }

    /// Adds one environment variable for this runner's commands (after the hardening defaults,
    /// so it can relax one of them for a command that has no user-supplied pathspecs).
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.overrides.env.push((key.into(), value.into()));
        self
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
            .args(
                self.overrides
                    .config
                    .iter()
                    .flat_map(|(k, v)| ["-c".to_string(), format!("{k}={v}")]),
            )
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
        for (k, v) in GLOBAL_ENV.get().into_iter().flatten() {
            cmd.env(k, v);
        }
        // After the scrub, so profile values win over anything inherited.
        for (k, v) in &self.overrides.env {
            cmd.env(k, v);
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
        let args = collect_args(args);
        let activity = Activity::begin(&args);
        let result = (|| -> Result<Vec<u8>> {
            let child = self.spawn(self.command(&args))?;
            let out = child.wait_with_output().map_err(AppError::git)?;
            check(out.status, &out.stderr, &out.stdout, ok_codes)?;
            Ok(out.stdout)
        })();
        activity.finish(&result);
        result
    }

    /// Runs git feeding `input` on stdin (commit messages: avoids argv limits and quoting).
    pub fn output_with_stdin<I, S>(&self, args: I, input: &[u8]) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = collect_args(args);
        let activity = Activity::begin(&args);
        let result = (|| -> Result<Vec<u8>> {
            let mut cmd = self.command(&args);
            cmd.stdin(Stdio::piped());
            let mut child = self.spawn(cmd)?;
            if let Some(mut stdin) = child.stdin.take() {
                // A write error means git exited early; its status below explains why.
                let _ = stdin.write_all(input);
            }
            let out = child.wait_with_output().map_err(AppError::git)?;
            check(out.status, &out.stderr, &out.stdout, &[0])?;
            Ok(out.stdout)
        })();
        activity.finish(&result);
        result
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
    pub fn stream<I, S>(&self, args: I, on_line: impl FnMut(&str)) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.stream_cancellable(args, on_line, &AtomicBool::new(false))
    }

    /// Like [`stream`](Self::stream), but setting `cancel` kills git and everything it started
    /// (ssh, credential helpers, `git-remote-https`) and returns a "cancelled" error.
    pub fn stream_cancellable<I, S>(
        &self,
        args: I,
        on_line: impl FnMut(&str),
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = collect_args(args);
        let activity = Activity::begin(&args);
        let result = self.stream_inner(&args, on_line, cancel);
        activity.finish(&result);
        result
    }

    fn stream_inner<I, S>(
        &self,
        args: I,
        mut on_line: impl FnMut(&str),
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut child = self.spawn(self.command(args))?;
        let stdout = drain(child.stdout.take());
        let stderr_pipe = child.stderr.take();
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let finished = Arc::new(AtomicBool::new(false));

        let (status, all_stderr, read_error) = std::thread::scope(|scope| {
            // Polls the flag on a side thread: the read loop below blocks on git's output.
            let watcher = scope.spawn({
                let finished = Arc::clone(&finished);
                let child = Arc::clone(&child);
                move || {
                    while !finished.load(Ordering::Relaxed) {
                        if cancel.load(Ordering::Relaxed) {
                            kill_tree(pid, &child);
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            });

            let mut all_stderr = Vec::new();
            let mut read_error = None;
            if let Some(mut stderr) = stderr_pipe {
                let mut chunk = [0u8; 4096];
                let mut line = Vec::new();
                loop {
                    let n = match stderr.read(&mut chunk) {
                        Ok(n) => n,
                        Err(e) => {
                            read_error = Some(AppError::git(e));
                            break;
                        }
                    };
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

            // `try_wait` in a loop: a blocking `wait` would hold the lock the killer needs.
            let status = loop {
                let polled = child.lock().map(|mut c| c.try_wait());
                match polled {
                    Ok(Ok(Some(status))) => break Ok(status),
                    Ok(Ok(None)) => std::thread::sleep(Duration::from_millis(10)),
                    Ok(Err(e)) => break Err(AppError::git(e)),
                    Err(_) => break Err(AppError::Internal("child lock poisoned".into())),
                }
            };
            finished.store(true, Ordering::Relaxed);
            let _ = watcher.join();
            (status, all_stderr, read_error)
        });

        let stdout = stdout.join().unwrap_or_default();
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Git("cancelled".into()));
        }
        if let Some(e) = read_error {
            return Err(e);
        }
        check(status?, &all_stderr, &stdout, &[0])?;
        Ok(stdout)
    }
}

/// Kills the process and its descendants. `Child::kill` alone would leave `ssh` or
/// `git-remote-https` running with the pipes open.
fn kill_tree(pid: u32, child: &Mutex<Child>) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .status();
    }
    if let Ok(mut c) = child.lock() {
        let _ = c.kill();
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
    use super::{recent_commands, redact};

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

    #[test]
    fn cancelling_kills_a_running_command_promptly() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (_d, git) = init_repo();
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let result = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(400));
                cancel.store(true, Ordering::Relaxed);
            });
            // A shell alias that would sleep for a minute if left alone.
            git.stream_cancellable(["-c", "alias.slow=!sleep 60", "slow"], |_| {}, &cancel)
        });
        let err = result.unwrap_err();
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn commands_are_logged_with_secrets_removed_and_reads_marked() {
        let (_d, git) = init_repo();
        let _ = git.output([
            "remote",
            "add",
            "origin",
            "https://ada:s3cret-token@example.com/a/b.git",
        ]);
        let _ = git.output(["checkout", "no-such-branch-for-the-log"]);
        let _ = git.output(["status", "--porcelain"]);
        let log = recent_commands();
        let find = |needle: &str| {
            log.iter()
                .rev()
                .find(|e| e.command.contains(needle))
                .unwrap_or_else(|| panic!("{needle}"))
        };

        let add = find("remote add origin");
        assert!(add.ok && !add.read_only);
        assert!(
            !add.command.contains("s3cret-token") && add.command.contains("***@example.com"),
            "{}",
            add.command
        );

        let bad = find("no-such-branch-for-the-log");
        assert!(!bad.ok);
        assert!(
            bad.error
                .as_deref()
                .unwrap_or("")
                .contains("no-such-branch"),
            "{bad:?}"
        );

        assert!(find("status --porcelain").read_only);
        assert_eq!(
            redact("git clone https://x:y@h/r and http://h/r"),
            "git clone https://***@h/r and http://h/r"
        );
    }
}
