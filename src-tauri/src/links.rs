//! Links that open Perseus: `perseus-app://open?path=<folder>[&commit=<id>]`.
//!
//! A link is input from outside the app (a web page, a chat message, a script), so it is handled
//! like any other untrusted input:
//!
//! - only the `open` action exists, and it only opens a folder and optionally selects a commit;
//!   nothing a link says ever runs git, clones, or changes a repository;
//! - a folder already in the recent list opens as is; any other folder first needs a yes from a
//!   native dialog that the webview cannot answer or suppress, and must be a git repository;
//! - only one such dialog is shown at a time, so a page cannot bury the user in prompts.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::ipc::channels::AppState;
use crate::recents::RecentStore;

pub const SCHEME: &str = "perseus-app";

const MAX_PATH: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    /// An absolute folder.
    pub path: String,
    /// A commit to select, as hex digits (4 to 40 of them).
    pub commit: Option<String>,
}

/// Reads a link, or returns `None` for anything that is not exactly the supported form.
pub fn parse(raw: &str) -> Option<Link> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if url.scheme() != SCHEME || url.host_str() != Some("open") || !matches!(url.path(), "" | "/") {
        return None;
    }
    let mut path = None;
    let mut commit = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "path" if path.is_none() => path = Some(value.into_owned()),
            "commit" if commit.is_none() => commit = Some(value.into_owned()),
            _ => {}
        }
    }
    let path = path?;
    if path.is_empty()
        || path.len() > MAX_PATH
        || path.chars().any(char::is_control)
        || !Path::new(&path).is_absolute()
    {
        return None;
    }
    let commit = match commit {
        None => None,
        Some(c) if (4..=40).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(c.to_ascii_lowercase())
        }
        // A malformed commit makes the whole link suspect rather than silently opening without it.
        Some(_) => return None,
    };
    Some(Link { path, commit })
}

/// The same folder under different spellings: slashes, a trailing slash and (on Windows) case.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p.to_string()
        }
    };
    norm(a) == norm(b)
}

/// Links wait here until the webview is ready to receive them, and are sent straight through after.
#[derive(Default)]
pub struct LinkState {
    pending: Mutex<Vec<Link>>,
    sink: Mutex<Option<Channel<Link>>>,
}

impl LinkState {
    /// The webview calls this once at start-up. Links that arrived before are delivered now.
    pub fn watch(&self, channel: Channel<Link>) {
        let Ok(mut sink) = self.sink.lock() else {
            return;
        };
        if let Ok(mut pending) = self.pending.lock() {
            for link in pending.drain(..) {
                let _ = channel.send(link);
            }
        }
        *sink = Some(channel);
    }

    fn deliver(&self, link: Link) {
        if let Ok(sink) = self.sink.lock()
            && let Some(channel) = sink.as_ref()
            && channel.send(link.clone()).is_ok()
        {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.push(link);
        }
    }
}

static ASKING: AtomicBool = AtomicBool::new(false);

/// Native yes/no for a folder the app has not seen. `false` when one is already open.
fn confirm(app: &AppHandle, path: &str) -> bool {
    if ASKING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let yes = app
        .dialog()
        .message(format!(
            "A link outside Perseus asks to open this folder:\n\n{path}\n\nOnly open folders you trust."
        ))
        .title("Open a repository from a link?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Open".into(), "Cancel".into()))
        .blocking_show();
    ASKING.store(false, Ordering::SeqCst);
    yes
}

fn tell(app: &AppHandle, text: String) {
    app.dialog()
        .message(text)
        .title("Perseus")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// Brings the window forward: a link is a request to look at something.
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.webview_windows().into_values().next() {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Handles the web addresses an operating system or a second launch handed to the app.
pub fn handle(app: &AppHandle, urls: Vec<String>) {
    let links: Vec<Link> = urls.iter().filter_map(|u| parse(u)).collect();
    if links.is_empty() {
        return;
    }
    show_window(app);
    let app = app.clone();
    // The confirmation blocks; never do that on the thread that delivered the link.
    tauri::async_runtime::spawn_blocking(move || {
        for link in links {
            admit(&app, link);
        }
    });
}

fn admit(app: &AppHandle, link: Link) {
    let recents = app.state::<RecentStore>();
    let known = recents
        .list()
        .ok()
        .and_then(|list| list.into_iter().find(|r| same_path(&r.path, &link.path)));
    let path = match known {
        Some(r) if r.exists => r.path,
        Some(r) => {
            tell(app, format!("{} no longer exists.", r.path));
            return;
        }
        None => {
            if !Path::new(&link.path).is_dir() {
                tell(
                    app,
                    format!("{} is not a folder on this computer.", link.path),
                );
                return;
            }
            if !confirm(app, &link.path) {
                return;
            }
            let state = app.state::<AppState>();
            let info = match state.repos.open(Path::new(&link.path)) {
                Ok(info) => info,
                Err(_) => {
                    tell(app, format!("{} is not a git repository.", link.path));
                    return;
                }
            };
            // The webview opens it again through the recent list, like any other recent.
            state.repos.close(info.id);
            let path = info.path.to_string_lossy().into_owned();
            if recents.touch(&path, &info.name).is_err() {
                return;
            }
            path
        }
    };
    app.state::<LinkState>().deliver(Link {
        path,
        commit: link.commit,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:{p}")
        } else {
            p.to_string()
        }
    }

    #[test]
    fn a_plain_open_link_is_read() {
        let raw = format!("perseus-app://open?path={}", abs("/work/repo"));
        assert_eq!(
            parse(&raw),
            Some(Link {
                path: abs("/work/repo"),
                commit: None
            })
        );
    }

    #[test]
    fn encoded_paths_and_a_commit_are_read() {
        let raw = "perseus-app://open/?path=C%3A%5CMy%20Repos%5Cperseus&commit=ABCdef12";
        if cfg!(windows) {
            assert_eq!(
                parse(raw),
                Some(Link {
                    path: r"C:\My Repos\perseus".into(),
                    commit: Some("abcdef12".into())
                })
            );
        }
        let unix = "perseus-app://open?path=%2Fhome%2Fme%2Frepo&commit=0123456789abcdef0123456789abcdef01234567";
        if !cfg!(windows) {
            assert_eq!(parse(unix).unwrap().path, "/home/me/repo");
        }
    }

    #[test]
    fn other_schemes_hosts_and_actions_are_ignored() {
        let p = abs("/x");
        for bad in [
            format!("https://open?path={p}"),
            format!("perseus://open?path={p}"),
            format!("perseus-app://clone?path={p}"),
            format!("perseus-app://open/extra?path={p}"),
            format!("perseus-app://evil.example/open?path={p}"),
            "perseus-app://open".to_string(),
            "perseus-app://open?commit=abcd".to_string(),
            "not a url".to_string(),
            String::new(),
        ] {
            assert_eq!(parse(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn relative_odd_and_oversized_paths_are_refused() {
        for bad in [
            "perseus-app://open?path=relative/dir".to_string(),
            "perseus-app://open?path=..%2F..%2Fetc".to_string(),
            "perseus-app://open?path=".to_string(),
            format!("perseus-app://open?path={}%0Aq", abs("/x")),
            format!("perseus-app://open?path={}%00", abs("/x")),
            format!("perseus-app://open?path={}", "a".repeat(MAX_PATH + 1)),
        ] {
            assert_eq!(parse(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_bad_commit_spoils_the_link() {
        let p = abs("/x");
        for bad in [
            "zzzz",
            "abc",
            "--help",
            "abcd%20",
            &"a".repeat(41),
            "1234;rm",
        ] {
            assert_eq!(
                parse(&format!("perseus-app://open?path={p}&commit={bad}")),
                None,
                "{bad:?}"
            );
        }
        assert!(parse(&format!("perseus-app://open?path={p}&commit=abcd")).is_some());
    }

    #[test]
    fn the_first_value_of_a_repeated_key_wins_and_unknown_keys_are_ignored() {
        let p = abs("/first");
        let q = abs("/second");
        let link = parse(&format!("perseus-app://open?path={p}&path={q}&mode=delete")).unwrap();
        assert_eq!(link.path, p);
    }

    #[test]
    fn paths_match_across_slashes_and_trailing_separators() {
        assert!(same_path("C:/Repos/App/", r"C:\Repos\App"));
        assert!(!same_path("C:/Repos/App", "C:/Repos/App2"));
        assert_eq!(same_path("/a/B", "/a/b"), cfg!(windows));
    }
}
