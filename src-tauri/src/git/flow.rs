//! Gitflow: feature, release and hotfix branches with the usual start and finish steps.
//!
//! Done with plain git commands, and with the same `gitflow.*` configuration keys as the
//! `git flow` command line tool, so a repository set up with either works with both. Nothing here
//! needs that tool to be installed.
//!
//! `finish` can be run again after a merge stopped on conflicts: every step first checks whether
//! it is already done, so it carries on from where it stopped instead of starting over.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlowKind {
    Feature,
    Release,
    Hotfix,
}

/// Branch names and prefixes, as `git flow init` records them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowConfig {
    /// The branch that always holds released code.
    pub main: String,
    /// The branch finished features are merged into.
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    /// Put in front of the version in a release's tag (`v` gives `v1.2.0`).
    pub tag_prefix: String,
}

impl FlowConfig {
    fn defaults(main: &str) -> Self {
        FlowConfig {
            main: main.into(),
            develop: "develop".into(),
            feature: "feature/".into(),
            release: "release/".into(),
            hotfix: "hotfix/".into(),
            tag_prefix: String::new(),
        }
    }

    fn prefix(&self, kind: FlowKind) -> &str {
        match kind {
            FlowKind::Feature => &self.feature,
            FlowKind::Release => &self.release,
            FlowKind::Hotfix => &self.hotfix,
        }
    }

    /// Where a new branch of `kind` starts, and where it is merged back.
    fn base(&self, kind: FlowKind) -> &str {
        match kind {
            FlowKind::Feature | FlowKind::Release => &self.develop,
            FlowKind::Hotfix => &self.main,
        }
    }

    fn validate(&self) -> Result<()> {
        validate::ref_name(&self.main)?;
        validate::ref_name(&self.develop)?;
        if self.main == self.develop {
            return Err(AppError::Git(
                "The main and develop branches must differ".into(),
            ));
        }
        let prefixes = [&self.feature, &self.release, &self.hotfix];
        for p in prefixes {
            if !p.ends_with('/') || p.len() < 2 {
                return Err(AppError::Git(
                    "A branch prefix must end with a slash, like feature/".into(),
                ));
            }
            validate::ref_name(p.trim_end_matches('/'))?;
        }
        if prefixes[0] == prefixes[1] || prefixes[0] == prefixes[2] || prefixes[1] == prefixes[2] {
            return Err(AppError::Git("The three prefixes must differ".into()));
        }
        if !self.tag_prefix.is_empty() {
            validate::ref_name(&format!("{}x", self.tag_prefix))?;
        }
        Ok(())
    }
}

/// The branch Gitflow is currently on, when it is one of its own.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FlowCurrent {
    pub kind: FlowKind,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FlowStatus {
    /// Set up (by Perseus or by `git flow init`) and both long-lived branches exist.
    pub initialized: bool,
    /// What is recorded, or the suggested defaults when it is not set up yet.
    pub config: FlowConfig,
    pub features: Vec<String>,
    pub releases: Vec<String>,
    pub hotfixes: Vec<String>,
    pub current: Option<FlowCurrent>,
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn config_value(git: &Git, key: &str) -> Result<Option<String>> {
    let out = git.output_allowing(["config", "--local", "--get", key], &[0, 1])?;
    Ok(Some(text(out)).filter(|v| !v.is_empty()))
}

fn set_config(git: &Git, key: &str, value: &str) -> Result<()> {
    git.output(["config", "--local", key, value])?;
    Ok(())
}

fn branches(git: &Git) -> Result<Vec<String>> {
    let out = text(git.output(["for-each-ref", "--format=%(refname:short)", "refs/heads"])?);
    Ok(out.lines().map(str::to_string).collect())
}

fn current_branch(git: &Git) -> Result<Option<String>> {
    let out = git.output_allowing(["symbolic-ref", "--short", "-q", "HEAD"], &[0, 1])?;
    Ok(Some(text(out)).filter(|b| !b.is_empty()))
}

fn stored_config(git: &Git) -> Result<Option<FlowConfig>> {
    let (Some(main), Some(develop)) = (
        config_value(git, "gitflow.branch.master")?,
        config_value(git, "gitflow.branch.develop")?,
    ) else {
        return Ok(None);
    };
    let mut cfg = FlowConfig::defaults(&main);
    cfg.develop = develop;
    for (key, slot) in [
        ("gitflow.prefix.feature", &mut cfg.feature),
        ("gitflow.prefix.release", &mut cfg.release),
        ("gitflow.prefix.hotfix", &mut cfg.hotfix),
        ("gitflow.prefix.versiontag", &mut cfg.tag_prefix),
    ] {
        if let Some(v) = config_value(git, key)? {
            *slot = v;
        }
    }
    Ok(Some(cfg))
}

pub fn status(git: &Git) -> Result<FlowStatus> {
    let all = branches(git)?;
    let stored = stored_config(git)?;
    let config = stored.clone().unwrap_or_else(|| {
        let main = ["main", "master"]
            .into_iter()
            .find(|m| all.iter().any(|b| b == m))
            .map(str::to_string)
            .or_else(|| current_branch(git).ok().flatten())
            .unwrap_or_else(|| "main".into());
        FlowConfig::defaults(&main)
    });
    let initialized = stored.is_some()
        && all.contains(&config.main)
        && all.contains(&config.develop)
        && config.validate().is_ok();
    let with_prefix = |kind: FlowKind| -> Vec<String> {
        all.iter()
            .filter_map(|b| {
                b.strip_prefix(config.prefix(kind))
                    .filter(|n| !n.is_empty())
            })
            .map(str::to_string)
            .collect()
    };
    let current = current_branch(git)?.and_then(|b| {
        [FlowKind::Feature, FlowKind::Release, FlowKind::Hotfix]
            .into_iter()
            .find_map(|kind| {
                b.strip_prefix(config.prefix(kind))
                    .filter(|n| !n.is_empty())
                    .map(|n| FlowCurrent {
                        kind,
                        name: n.to_string(),
                    })
            })
    });
    Ok(FlowStatus {
        initialized,
        features: with_prefix(FlowKind::Feature),
        releases: with_prefix(FlowKind::Release),
        hotfixes: with_prefix(FlowKind::Hotfix),
        current,
        config,
    })
}

/// Records the configuration and creates the develop branch from the main one if it is missing.
pub fn init(git: &Git, cfg: &FlowConfig) -> Result<()> {
    cfg.validate()?;
    let all = branches(git)?;
    if !all.contains(&cfg.main) {
        return Err(AppError::Git(format!(
            "The main branch '{}' does not exist. Make a first commit, or pick another branch.",
            cfg.main
        )));
    }
    if !all.contains(&cfg.develop) {
        git.output(["branch", &cfg.develop, &cfg.main])?;
    }
    set_config(git, "gitflow.branch.master", &cfg.main)?;
    set_config(git, "gitflow.branch.develop", &cfg.develop)?;
    set_config(git, "gitflow.prefix.feature", &cfg.feature)?;
    set_config(git, "gitflow.prefix.release", &cfg.release)?;
    set_config(git, "gitflow.prefix.hotfix", &cfg.hotfix)?;
    set_config(git, "gitflow.prefix.versiontag", &cfg.tag_prefix)?;
    Ok(())
}

fn require_flow(git: &Git) -> Result<FlowConfig> {
    let s = status(git)?;
    if s.initialized {
        Ok(s.config)
    } else {
        Err(AppError::Git(
            "Gitflow is not set up in this repository yet".into(),
        ))
    }
}

/// A feature, release or hotfix name: one ref-safe piece, without blanks.
fn check_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.chars().any(char::is_whitespace) || name.ends_with('/') {
        return Err(AppError::Git("Give it a name without spaces".into()));
    }
    validate::ref_name(name)
}

/// Starts a feature or release from develop, or a hotfix from the main branch, and checks it out.
pub fn start(git: &Git, kind: FlowKind, name: &str) -> Result<()> {
    let cfg = require_flow(git)?;
    let name = check_name(name)?;
    let branch = format!("{}{name}", cfg.prefix(kind));
    validate::ref_name(&branch)?;
    if branches(git)?.contains(&branch) {
        return Err(AppError::Git(format!(
            "The branch '{branch}' already exists"
        )));
    }
    git.output(["switch", "-c", &branch, cfg.base(kind)])?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FinishOptions {
    /// Keep the branch after merging it.
    #[serde(default)]
    pub keep_branch: bool,
    /// Features only: merge all its commits as one.
    #[serde(default)]
    pub squash: bool,
    /// Releases and hotfixes: the tag's message (the default names the version).
    #[serde(default)]
    pub tag_message: Option<String>,
}

/// True when everything on `branch` is already in `target`.
fn merged(git: &Git, branch: &str, target: &str) -> Result<bool> {
    let out = git.output(["rev-list", "--count", &format!("{target}..{branch}")])?;
    Ok(text(out) == "0")
}

fn switch_to(git: &Git, branch: &str) -> Result<()> {
    if current_branch(git)?.as_deref() != Some(branch) {
        git.output(["switch", branch])?;
    }
    Ok(())
}

fn merge_into(git: &Git, branch: &str, target: &str) -> Result<()> {
    if merged(git, branch, target)? {
        return Ok(());
    }
    switch_to(git, target)?;
    git.output([
        "merge",
        "--no-ff",
        "-m",
        &format!("Merge branch '{branch}' into {target}"),
        branch,
    ])?;
    Ok(())
}

/// Merges a feature (or a release or hotfix and its tag) back and removes the branch.
///
/// A conflict stops it with the merge unfinished. Resolve and continue as usual, then finish again:
/// the steps that were done are skipped.
pub fn finish(git: &Git, kind: FlowKind, name: &str, opts: &FinishOptions) -> Result<()> {
    let cfg = require_flow(git)?;
    let name = check_name(name)?;
    let branch = format!("{}{name}", cfg.prefix(kind));
    validate::ref_name(&branch)?;
    if !branches(git)?.contains(&branch) {
        return Err(AppError::Git(format!(
            "The branch '{branch}' does not exist"
        )));
    }
    let message = opts
        .tag_message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    if message.is_some_and(|m| m.contains('\0')) {
        return Err(AppError::Git("invalid tag message".into()));
    }

    let mut squashed = false;
    match kind {
        FlowKind::Feature if opts.squash => {
            if !merged(git, &branch, &cfg.develop)? {
                switch_to(git, &cfg.develop)?;
                git.output(["merge", "--squash", &branch])?;
                git.output(["commit", "-m", &format!("Add feature {name}")])?;
                squashed = true;
            }
        }
        FlowKind::Feature => merge_into(git, &branch, &cfg.develop)?,
        FlowKind::Release | FlowKind::Hotfix => {
            merge_into(git, &branch, &cfg.main)?;
            let tag = format!("{}{name}", cfg.tag_prefix);
            validate::ref_name(&tag)?;
            let have_tag = !text(git.output(["tag", "--list", &tag])?).is_empty();
            if !have_tag {
                let default = format!(
                    "{} {name}",
                    if kind == FlowKind::Release {
                        "Release"
                    } else {
                        "Hotfix"
                    }
                );
                git.output([
                    "tag",
                    "-a",
                    "-m",
                    message.unwrap_or(&default),
                    &tag,
                    &cfg.main,
                ])?;
            }
            merge_into(git, &branch, &cfg.develop)?;
        }
    }
    // Always end on the branch work continues on.
    switch_to(git, &cfg.develop)?;
    if !opts.keep_branch {
        // A squashed feature is not an ancestor of develop, so git needs to be told it is safe.
        git.output(["branch", if squashed { "-D" } else { "-d" }, &branch])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;
    use crate::git::ops::{GitOp, Operation, in_progress, run};

    fn setup() -> (tempfile::TempDir, Git, FlowConfig) {
        let (d, git) = init_repo();
        commit_file(&git, "base.txt", "base\n", "base");
        let cfg = status(&git).unwrap().config;
        init(&git, &cfg).unwrap();
        (d, git, cfg)
    }

    fn subjects(git: &Git, rev: &str, n: usize) -> Vec<String> {
        let out = git
            .output(["log", rev, &format!("-{n}"), "--format=%s"])
            .unwrap();
        text(out).lines().map(str::to_string).collect()
    }

    fn here(git: &Git) -> String {
        current_branch(git).unwrap().unwrap()
    }

    #[test]
    fn a_new_repository_suggests_defaults_and_init_sets_it_up() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");
        let before = status(&git).unwrap();
        assert!(!before.initialized);
        assert_eq!(before.config, FlowConfig::defaults("main"));

        init(&git, &before.config).unwrap();
        let after = status(&git).unwrap();
        assert!(after.initialized);
        assert!(branches(&git).unwrap().contains(&"develop".to_string()));
        // The same keys `git flow init` writes.
        assert_eq!(
            config_value(&git, "gitflow.branch.master")
                .unwrap()
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            config_value(&git, "gitflow.prefix.release")
                .unwrap()
                .as_deref(),
            Some("release/")
        );
        // Running it again changes nothing.
        init(&git, &after.config).unwrap();
        assert_eq!(status(&git).unwrap(), after);
    }

    #[test]
    fn init_checks_its_input() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");
        let ok = FlowConfig::defaults("main");
        for bad in [
            FlowConfig {
                main: "nope".into(),
                ..ok.clone()
            },
            FlowConfig {
                develop: "main".into(),
                ..ok.clone()
            },
            FlowConfig {
                feature: "feature".into(),
                ..ok.clone()
            },
            FlowConfig {
                release: "feature/".into(),
                ..ok.clone()
            },
            FlowConfig {
                develop: "--upload-pack=x".into(),
                ..ok.clone()
            },
            FlowConfig {
                tag_prefix: "-v".into(),
                ..ok.clone()
            },
        ] {
            assert!(init(&git, &bad).is_err(), "{bad:?}");
        }
        assert!(!status(&git).unwrap().initialized);
        assert!(!branches(&git).unwrap().contains(&"develop".to_string()));
    }

    #[test]
    fn starting_branches_begin_where_gitflow_says() {
        let (_d, git, _cfg) = setup();
        git.output(["switch", "-q", "develop"]).unwrap();
        commit_file(&git, "dev.txt", "dev\n", "on develop");

        start(&git, FlowKind::Feature, "login").unwrap();
        assert_eq!(here(&git), "feature/login");
        assert!(
            git.root().join("dev.txt").exists(),
            "a feature starts from develop"
        );

        start(&git, FlowKind::Hotfix, "1.0.1").unwrap();
        assert_eq!(here(&git), "hotfix/1.0.1");
        assert!(
            !git.root().join("dev.txt").exists(),
            "a hotfix starts from main"
        );

        let s = status(&git).unwrap();
        assert_eq!(s.features, ["login"]);
        assert_eq!(s.hotfixes, ["1.0.1"]);
        assert_eq!(
            s.current,
            Some(FlowCurrent {
                kind: FlowKind::Hotfix,
                name: "1.0.1".into()
            })
        );

        assert!(
            start(&git, FlowKind::Feature, "login").is_err(),
            "already there"
        );
        for bad in ["", "two words", "--all", "x/", "a..b"] {
            assert!(start(&git, FlowKind::Feature, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn nothing_starts_before_gitflow_is_set_up() {
        let (_d, git) = init_repo();
        commit_file(&git, "a.txt", "a\n", "first");
        assert!(start(&git, FlowKind::Feature, "x").is_err());
        assert!(finish(&git, FlowKind::Feature, "x", &FinishOptions::default()).is_err());
    }

    #[test]
    fn finishing_a_feature_merges_it_into_develop_and_removes_it() {
        let (_d, git, _cfg) = setup();
        start(&git, FlowKind::Feature, "login").unwrap();
        commit_file(&git, "login.txt", "login\n", "add login");
        finish(&git, FlowKind::Feature, "login", &FinishOptions::default()).unwrap();

        assert_eq!(here(&git), "develop");
        assert!(git.root().join("login.txt").exists());
        assert!(
            !branches(&git)
                .unwrap()
                .contains(&"feature/login".to_string())
        );
        assert_eq!(
            subjects(&git, "develop", 2),
            ["Merge branch 'feature/login' into develop", "add login"]
        );
        // main did not move.
        assert_eq!(subjects(&git, "main", 1), ["base"]);
    }

    #[test]
    fn a_feature_can_be_squashed_or_kept() {
        let (_d, git, _cfg) = setup();
        start(&git, FlowKind::Feature, "big").unwrap();
        commit_file(&git, "one.txt", "1\n", "step one");
        commit_file(&git, "two.txt", "2\n", "step two");
        let opts = FinishOptions {
            squash: true,
            ..Default::default()
        };
        finish(&git, FlowKind::Feature, "big", &opts).unwrap();
        assert_eq!(subjects(&git, "develop", 2), ["Add feature big", "base"]);
        assert!(git.root().join("two.txt").exists());
        assert!(!branches(&git).unwrap().contains(&"feature/big".to_string()));

        start(&git, FlowKind::Feature, "keepme").unwrap();
        commit_file(&git, "k.txt", "k\n", "keep");
        let opts = FinishOptions {
            keep_branch: true,
            ..Default::default()
        };
        finish(&git, FlowKind::Feature, "keepme", &opts).unwrap();
        assert!(
            branches(&git)
                .unwrap()
                .contains(&"feature/keepme".to_string())
        );
    }

    #[test]
    fn a_release_goes_into_main_gets_tagged_and_comes_back_to_develop() {
        let (_d, git, _cfg) = setup();
        git.output(["switch", "-q", "develop"]).unwrap();
        commit_file(&git, "feature.txt", "f\n", "a feature on develop");
        start(&git, FlowKind::Release, "1.0.0").unwrap();
        commit_file(&git, "VERSION", "1.0.0\n", "bump version");
        let opts = FinishOptions {
            tag_message: Some("First release".into()),
            ..Default::default()
        };
        finish(&git, FlowKind::Release, "1.0.0", &opts).unwrap();

        assert_eq!(here(&git), "develop");
        assert!(
            !branches(&git)
                .unwrap()
                .contains(&"release/1.0.0".to_string())
        );
        assert!(
            git.root().join("VERSION").exists(),
            "develop got the release fixes back"
        );
        // main holds the release, and the tag is on it, annotated.
        let main_tip = text(git.output(["rev-parse", "main"]).unwrap());
        assert_eq!(
            text(git.output(["rev-parse", "1.0.0^{commit}"]).unwrap()),
            main_tip
        );
        assert_eq!(
            text(git.output(["cat-file", "-t", "1.0.0"]).unwrap()),
            "tag"
        );
        assert!(text(git.output(["tag", "-n1", "1.0.0"]).unwrap()).contains("First release"));
        assert_eq!(
            subjects(&git, "main", 1),
            ["Merge branch 'release/1.0.0' into main"]
        );
    }

    #[test]
    fn a_hotfix_is_merged_into_both_main_and_develop() {
        let (_d, git, _cfg) = setup();
        start(&git, FlowKind::Hotfix, "1.0.1").unwrap();
        commit_file(&git, "fix.txt", "fix\n", "urgent fix");
        finish(&git, FlowKind::Hotfix, "1.0.1", &FinishOptions::default()).unwrap();
        for target in ["main", "develop"] {
            let tree = text(git.output(["ls-tree", "--name-only", target]).unwrap());
            assert!(tree.contains("fix.txt"), "{target} has the fix");
        }
        assert!(text(git.output(["tag", "--list", "1.0.1"]).unwrap()).contains("1.0.1"));
    }

    #[test]
    fn a_version_tag_prefix_is_used() {
        let (_d, git, mut cfg) = setup();
        cfg.tag_prefix = "v".into();
        init(&git, &cfg).unwrap();
        start(&git, FlowKind::Release, "2.0.0").unwrap();
        commit_file(&git, "r.txt", "r\n", "release work");
        finish(&git, FlowKind::Release, "2.0.0", &FinishOptions::default()).unwrap();
        assert_eq!(
            text(git.output(["tag", "--list", "v2.0.0"]).unwrap()),
            "v2.0.0"
        );
    }

    #[test]
    fn a_conflict_stops_the_finish_and_running_it_again_carries_on() {
        let (_d, git, _cfg) = setup();
        start(&git, FlowKind::Release, "1.0.0").unwrap();
        commit_file(&git, "notes.txt", "release notes\n", "write notes");
        // develop meanwhile changes the same file differently.
        git.output(["switch", "-q", "develop"]).unwrap();
        commit_file(&git, "notes.txt", "develop notes\n", "other notes");

        let err = finish(&git, FlowKind::Release, "1.0.0", &FinishOptions::default()).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("conflict"), "{err}");
        assert_eq!(in_progress(&git), Some(Operation::Merge));
        // main and the tag were already done when it stopped on develop.
        assert_eq!(here(&git), "develop");
        assert!(text(git.output(["tag", "--list", "1.0.0"]).unwrap()).contains("1.0.0"));

        write(&git, "notes.txt", "resolved\n");
        git.output(["add", "notes.txt"]).unwrap();
        run(&git, &GitOp::Continue, |_| {}).unwrap();

        finish(&git, FlowKind::Release, "1.0.0", &FinishOptions::default()).unwrap();
        assert!(
            !branches(&git)
                .unwrap()
                .contains(&"release/1.0.0".to_string())
        );
        assert_eq!(in_progress(&git), None);
    }
}
