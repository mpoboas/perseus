//! The isolation hook's command allowlist (JavaScript) and the commands the backend
//! registers (`build.rs`) are maintained by hand in two places. This test makes any
//! drift fail loudly: a command missing from the hook would silently stop working, and
//! a stale entry would keep an old command reachable.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// Every double-quoted string literal in `text`.
fn quoted(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        out.insert(after[..end].to_string());
        rest = &after[end + 1..];
    }
    out
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> &'a str {
    let start = text
        .find(open)
        .unwrap_or_else(|| panic!("`{open}` not found"))
        + open.len();
    let end = text[start..]
        .find(close)
        .unwrap_or_else(|| panic!("`{close}` not found"))
        + start;
    &text[start..end]
}

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn isolation_allowlist_matches_registered_commands() {
    let build = fs::read_to_string(root().join("build.rs")).unwrap();
    let registered = quoted(between(&build, "const COMMANDS: &[&str] = &[", "];"));

    let hook = fs::read_to_string(root().join("../isolation/index.js")).unwrap();
    let allowed = quoted(between(&hook, "const ALLOWED = new Set([", "]);"));

    assert!(
        registered.len() > 10,
        "parsed too few commands from build.rs: {registered:?}"
    );
    let missing: Vec<_> = registered.difference(&allowed).collect();
    let stale: Vec<_> = allowed.difference(&registered).collect();
    assert!(
        missing.is_empty(),
        "commands blocked by the isolation hook: {missing:?}"
    );
    assert!(
        stale.is_empty(),
        "isolation allows commands that no longer exist: {stale:?}"
    );
}

#[test]
fn every_registered_command_is_granted_to_the_main_window() {
    let build = fs::read_to_string(root().join("build.rs")).unwrap();
    let registered = quoted(between(&build, "const COMMANDS: &[&str] = &[", "];"));

    let caps = fs::read_to_string(root().join("capabilities/default.json")).unwrap();
    let granted = quoted(&caps);
    for cmd in &registered {
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission),
            "capability missing for `{cmd}` ({permission})"
        );
    }
}
