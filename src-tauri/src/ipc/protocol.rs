//! `perseus://` custom protocol: streams raw patch bytes to the webview without
//! JSON/Base64 wrapping. (`ipc://` is Tauri's own scheme, so we use our own name;
//! on Windows the webview addresses it as `http://perseus.localhost`.)
//!
//! Custom protocols sit outside Tauri's permission system, so this handler does
//! its own gatekeeping:
//!
//! * only the app's own origins may read responses (CORS allowlist + hard 403)
//! * the repository must be one the user opened through the folder picker
//! * every parameter is validated before it becomes a git argument

use std::collections::HashMap;

use tauri::http::{Method, Request, Response, StatusCode, header};
use url::Url;

use crate::error::AppError;
use crate::git::blob;
use crate::git::diff::{self, WorkSide};
use crate::git::repo::{RepoId, RepoRegistry};

pub const SCHEME: &str = "perseus";
const TRUNCATED_HEADER: &str = "x-perseus-truncated";

/// Origins the Tauri webview page can have. The dev server origin is accepted in debug builds only.
fn origin_allowed(origin: &str) -> bool {
    const ALWAYS: [&str; 3] = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ];
    ALWAYS.contains(&origin) || (cfg!(debug_assertions) && origin == "http://localhost:1420")
}

fn respond(
    status: StatusCode,
    origin: Option<&str>,
    body: Vec<u8>,
    truncated: bool,
) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header(header::VARY, "Origin");
    if let Some(o) = origin {
        b = b
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o)
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, TRUNCATED_HEADER);
    }
    if truncated {
        b = b.header(TRUNCATED_HEADER, "1");
    }
    b.body(body).expect("static response parts are valid")
}

fn fail(status: StatusCode, origin: Option<&str>, msg: impl Into<String>) -> Response<Vec<u8>> {
    respond(status, origin, msg.into().into_bytes(), false)
}

pub fn handle(repos: &RepoRegistry, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let Some(origin) = origin.filter(|o| origin_allowed(o)) else {
        return fail(StatusCode::FORBIDDEN, None, "forbidden");
    };
    let origin = Some(origin);

    match *request.method() {
        Method::OPTIONS => return respond(StatusCode::NO_CONTENT, origin, Vec::new(), false),
        Method::GET => {}
        _ => return fail(StatusCode::METHOD_NOT_ALLOWED, origin, "method not allowed"),
    }

    let Ok(url) = Url::parse(&request.uri().to_string()) else {
        return fail(StatusCode::BAD_REQUEST, origin, "bad url");
    };
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();

    match route(repos, url.path(), &q) {
        Ok((body, truncated)) => respond(StatusCode::OK, origin, body, truncated),
        Err(Failure::NotFound) => fail(StatusCode::NOT_FOUND, origin, "not found"),
        Err(Failure::Bad(msg)) => fail(StatusCode::BAD_REQUEST, origin, msg),
    }
}

enum Failure {
    NotFound,
    Bad(String),
}

impl From<AppError> for Failure {
    fn from(e: AppError) -> Self {
        Failure::Bad(e.to_string())
    }
}

fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> Result<&'a str, Failure> {
    q.get(key)
        .map(String::as_str)
        .ok_or_else(|| Failure::Bad(format!("missing parameter `{key}`")))
}

fn route(
    repos: &RepoRegistry,
    path: &str,
    q: &HashMap<String, String>,
) -> Result<(Vec<u8>, bool), Failure> {
    let repo_id: RepoId = param(q, "repo")?
        .parse()
        .map_err(|_| Failure::Bad("invalid repo".into()))?;
    let git = repos.git(repo_id)?;
    let file = param(q, "path")?;
    let orig = q.get("orig").map(String::as_str);

    match path {
        "/diff" => Ok(diff::commit_patch(&git, param(q, "oid")?, file, orig)?),
        // One version of a file, for the picture view.
        "/blob" => {
            let source = blob::Source::parse(param(q, "rev")?)?;
            blob::read(&git, &source, file)?.ok_or(Failure::NotFound)
        }
        "/wdiff" => {
            let side = match param(q, "side")? {
                "unstaged" => WorkSide::Unstaged,
                "staged" => WorkSide::Staged,
                "untracked" => WorkSide::Untracked,
                _ => return Err(Failure::Bad("invalid side".into())),
            };
            Ok(diff::worktree_patch(&git, side, file, orig)?)
        }
        _ => Err(Failure::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn get(repos: &RepoRegistry, uri: &str, origin: Option<&str>) -> Response<Vec<u8>> {
        let mut b = Request::builder().method(Method::GET).uri(uri);
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        handle(repos, &b.body(Vec::new()).unwrap())
    }

    fn setup() -> (tempfile::TempDir, RepoRegistry, u32, String) {
        let (dir, git) = init_repo();
        commit_file(&git, "a.txt", "one\n", "first");
        commit_file(&git, "a.txt", "two\n", "second");
        let oid = String::from_utf8(git.output(["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .to_string();
        let repos = RepoRegistry::default();
        let id = repos.open(dir.path()).unwrap().id;
        (dir, repos, id, oid)
    }

    const OK: Option<&str> = Some("http://tauri.localhost");

    #[test]
    fn serves_commit_and_worktree_patches() {
        let (_d, repos, id, oid) = setup();
        let res = get(
            &repos,
            &format!("http://perseus.localhost/diff?repo={id}&oid={oid}&path=a.txt"),
            OK,
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://tauri.localhost"
        );
        assert!(String::from_utf8_lossy(res.body()).contains("+two"));

        let git = repos.git(id).unwrap();
        write(&git, "a.txt", "three\n");
        let res = get(
            &repos,
            &format!("perseus://localhost/wdiff?repo={id}&side=unstaged&path=a.txt"),
            OK,
        );
        assert!(String::from_utf8_lossy(res.body()).contains("+three"));
    }

    #[test]
    fn serves_file_versions_for_the_picture_view() {
        let (_d, repos, id, oid) = setup();
        let blob = |rev: &str, path: &str| {
            get(
                &repos,
                &format!("http://perseus.localhost/blob?repo={id}&rev={rev}&path={path}"),
                OK,
            )
        };
        let res = blob(&oid, "a.txt");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"two\n");
        assert_eq!(blob(&format!("{oid}%5E"), "a.txt").body(), b"one\n");
        assert_eq!(blob("work", "a.txt").body(), b"two\n");
        // A version that does not exist is a plain 404, and bad input is refused.
        assert_eq!(blob(&oid, "nope.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(blob("main", "a.txt").status(), StatusCode::BAD_REQUEST);
        assert_eq!(blob("work", "..%2Fx").status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn foreign_or_missing_origins_are_refused() {
        let (_d, repos, id, oid) = setup();
        let uri = format!("http://perseus.localhost/diff?repo={id}&oid={oid}&path=a.txt");
        for origin in [
            None,
            Some("https://evil.example"),
            Some("null"),
            Some("http://localhost:9999"),
        ] {
            let res = get(&repos, &uri, origin);
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{origin:?}");
            assert!(
                res.headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_none()
            );
            assert!(res.body().starts_with(b"forbidden"));
        }
    }

    #[test]
    fn rejects_bad_requests() {
        let (_d, repos, id, oid) = setup();
        let status = |uri: String| get(&repos, &uri, OK).status();
        let base = "http://perseus.localhost";

        assert_eq!(
            status(format!("{base}/diff?repo=999&oid={oid}&path=a.txt")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/diff?repo=x&oid={oid}&path=a.txt")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/diff?repo={id}&oid=HEAD&path=a.txt")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/diff?repo={id}&oid={oid}&path=..%2Fx")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/diff?repo={id}&oid={oid}")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/wdiff?repo={id}&side=bogus&path=a.txt")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(format!("{base}/other?repo={id}&path=a.txt")),
            StatusCode::NOT_FOUND
        );

        let post = Request::builder()
            .method(Method::POST)
            .uri(format!("{base}/diff"))
            .header(header::ORIGIN, "http://tauri.localhost")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            handle(&repos, &post).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn marks_truncated_patches() {
        let (_d, repos, id, _oid) = setup();
        let git = repos.git(id).unwrap();
        write(&git, "big.txt", &"z".repeat(diff::MAX_PATCH_BYTES + 10));
        let res = get(
            &repos,
            &format!("http://perseus.localhost/wdiff?repo={id}&side=untracked&path=big.txt"),
            OK,
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[TRUNCATED_HEADER], "1");
        assert_eq!(res.body().len(), diff::MAX_PATCH_BYTES);
    }
}
