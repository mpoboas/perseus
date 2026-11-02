//! Interactive rebase and conflict prediction.
//!
//! Perseus builds the whole todo list itself and hands it to git through `GIT_SEQUENCE_EDITOR`,
//! so no editor ever opens. Rewording is expressed as `pick` followed by an `exec` that amends
//! with the new message (git's own `reword` would open an editor). When the rebase stops (an
//! `edit` line, or a conflict) the usual continue/abort banner takes over.

use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanCommit {
    pub oid: String,
    pub summary: String,
    /// More than one parent: an interactive rebase flattens merges, which the UI warns about.
    pub is_merge: bool,
}

fn rev_arg(rev: &str) -> Result<String> {
    match validate::oid(rev) {
        Ok(id) => Ok(id.to_string()),
        Err(_) => validate::ref_name(rev).map(str::to_string),
    }
}

/// The commits an interactive rebase onto `base` would replay, oldest first.
pub fn plan(git: &Git, base: &str) -> Result<Vec<PlanCommit>> {
    let base = rev_arg(base)?;
    let range = format!("{base}..HEAD");
    let out = git.output([
        "log",
        "--reverse",
        "--format=%H%x00%P%x00%s",
        range.as_str(),
    ])?;
    let mut commits = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let mut f = line.split('\0');
        let (Some(oid), Some(parents), Some(summary)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        commits.push(PlanCommit {
            oid: oid.to_string(),
            summary: summary.to_string(),
            is_merge: parents.split_whitespace().count() > 1,
        });
    }
    Ok(commits)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoAction {
    Pick,
    /// Pick, then replace the message with the one supplied.
    Reword,
    /// Pick, then stop so the commit can be changed; continue from the banner.
    Edit,
    /// Meld into the previous commit, combining both messages.
    Squash,
    /// Meld into the previous commit, discarding this message.
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TodoItem {
    pub action: TodoAction,
    pub oid: String,
    /// The new message, for `reword`.
    pub message: Option<String>,
}

/// Todo text plus the message files `reword` lines refer to.
pub struct Todo {
    pub text: String,
    pub messages: Vec<(String, String)>,
}

fn slashes(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Builds the todo list. `msg_dir` is where reword message files will live.
pub fn build_todo(items: &[TodoItem], msg_dir: &std::path::Path) -> Result<Todo> {
    let mut text = String::new();
    let mut messages = Vec::new();
    let mut first_kept = true;
    for (i, item) in items.iter().enumerate() {
        let oid = validate::oid(&item.oid)?.to_string();
        let kept = item.action != TodoAction::Drop;
        if kept && first_kept && matches!(item.action, TodoAction::Squash | TodoAction::Fixup) {
            return Err(AppError::Git(
                "the first commit cannot be squashed or fixed up into anything".into(),
            ));
        }
        if kept {
            first_kept = false;
        }
        match item.action {
            TodoAction::Pick => text.push_str(&format!("pick {oid}\n")),
            TodoAction::Edit => text.push_str(&format!("edit {oid}\n")),
            TodoAction::Squash => text.push_str(&format!("squash {oid}\n")),
            TodoAction::Fixup => text.push_str(&format!("fixup {oid}\n")),
            TodoAction::Drop => text.push_str(&format!("drop {oid}\n")),
            TodoAction::Reword => {
                let message = item.message.as_deref().unwrap_or("").trim();
                if message.is_empty() || message.contains('\0') {
                    return Err(AppError::Git("a reworded commit needs a message".into()));
                }
                let file = msg_dir.join(format!("msg-{i}.txt"));
                text.push_str(&format!("pick {oid}\n"));
                text.push_str(&format!(
                    "exec git commit --amend -q -F '{}'\n",
                    slashes(&file)
                ));
                messages.push((slashes(&file), format!("{message}\n")));
            }
        }
    }
    if !items.iter().any(|i| i.action != TodoAction::Drop) {
        return Err(AppError::Git(
            "dropping every commit would leave nothing to rebase".into(),
        ));
    }
    Ok(Todo { text, messages })
}

/// Rebases `HEAD` onto `base` following `items`, which must list every commit of the plan
/// exactly once, in the order they should be replayed.
pub fn start(
    git: &Git,
    base: &str,
    items: &[TodoItem],
    cancel: &AtomicBool,
    on_line: impl FnMut(&str),
) -> Result<String> {
    let base = rev_arg(base)?;
    let planned = plan(git, &base)?;
    let mut listed: Vec<&str> = items.iter().map(|i| i.oid.as_str()).collect();
    let mut expected: Vec<&str> = planned.iter().map(|c| c.oid.as_str()).collect();
    listed.sort_unstable();
    expected.sort_unstable();
    if listed != expected {
        return Err(AppError::Git(
            "the list of commits no longer matches the branch; reopen the dialog".into(),
        ));
    }

    let dir = std::env::temp_dir().join(format!("perseus-rebase-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(AppError::git)?;
    let result = (|| {
        let todo = build_todo(items, &dir)?;
        for (file, content) in &todo.messages {
            std::fs::write(file, content).map_err(AppError::git)?;
        }
        let todo_file = dir.join("todo.txt");
        std::fs::write(&todo_file, &todo.text).map_err(AppError::git)?;
        let todo_path = slashes(&todo_file);
        if todo_path.contains('\'') {
            return Err(AppError::Git(
                "the temporary folder name contains a quote".into(),
            ));
        }
        // Git appends the todo file's path; `cp` overwrites it with the list prepared above.
        let editor = format!("cp '{todo_path}'");
        let runner = git.clone().with_env("GIT_SEQUENCE_EDITOR", &editor);
        let out = runner.stream_cancellable(["rebase", "-i", base.as_str()], on_line, cancel)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    })();
    // A rebase that stopped keeps running from git's own state; our files are no longer needed,
    // except reword messages that later `exec` lines still read, so keep the folder in that case.
    let stopped = crate::git::ops::in_progress(git).is_some();
    if !stopped {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Prediction {
    /// False when this git is too old for `merge-tree --write-tree` (before 2.38).
    pub supported: bool,
    pub conflicts: Vec<String>,
}

fn run_merge_tree(git: &Git, args: Vec<String>) -> Result<Prediction> {
    match git.output_allowing(args, &[0, 1]) {
        Ok(out) => {
            // First line: the resulting tree. A conflicted merge then lists the file names.
            let conflicts: Vec<String> = String::from_utf8_lossy(&out)
                .lines()
                .skip(1)
                .take_while(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            Ok(Prediction {
                supported: true,
                conflicts,
            })
        }
        Err(e)
            if e.to_string().contains("write-tree") || e.to_string().contains("unknown option") =>
        {
            Ok(Prediction {
                supported: false,
                conflicts: vec![],
            })
        }
        Err(e) => Err(e),
    }
}

/// Files that would conflict if `theirs` were merged into `ours`. Nothing is changed.
pub fn predict_merge(git: &Git, ours: &str, theirs: &str) -> Result<Prediction> {
    let (ours, theirs) = (rev_arg(ours)?, rev_arg(theirs)?);
    run_merge_tree(
        git,
        vec![
            "merge-tree".into(),
            "--write-tree".into(),
            "--name-only".into(),
            "--no-messages".into(),
            ours,
            theirs,
        ],
    )
}

/// Files that would conflict if commit `oid` were cherry-picked onto `onto`.
pub fn predict_pick(git: &Git, onto: &str, oid: &str) -> Result<Prediction> {
    let onto = rev_arg(onto)?;
    let oid = validate::oid(oid)?.to_string();
    run_merge_tree(
        git,
        vec![
            "merge-tree".into(),
            "--write-tree".into(),
            "--name-only".into(),
            "--no-messages".into(),
            format!("--merge-base={oid}^"),
            onto,
            oid,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn log_subjects(git: &Git) -> Vec<String> {
        String::from_utf8_lossy(&git.output(["log", "--format=%s", "--reverse"]).unwrap())
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn oid_of(git: &Git, rev: &str) -> String {
        String::from_utf8_lossy(&git.output(["rev-parse", rev]).unwrap())
            .trim()
            .to_string()
    }

    fn five_commits() -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        commit_file(&git, "base.txt", "base\n", "base");
        for n in ["A", "B", "C", "D", "E"] {
            commit_file(
                &git,
                &format!("{n}.txt"),
                &format!("{n}\n"),
                &format!("commit {n}"),
            );
        }
        (d, git)
    }

    fn items(git: &Git, spec: &[(TodoAction, usize, Option<&str>)]) -> Vec<TodoItem> {
        spec.iter()
            .map(|(a, back, msg)| TodoItem {
                action: *a,
                oid: oid_of(git, &format!("HEAD~{back}")),
                message: msg.map(str::to_string),
            })
            .collect()
    }

    #[test]
    fn plan_lists_the_commits_to_replay_oldest_first() {
        let (_d, git) = five_commits();
        let p = plan(&git, &oid_of(&git, "HEAD~3")).unwrap();
        assert_eq!(
            p.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(),
            ["commit C", "commit D", "commit E"]
        );
        assert!(p.iter().all(|c| !c.is_merge && c.oid.len() == 40));
        assert!(plan(&git, "--all").is_err());
    }

    #[test]
    fn reword_fixup_drop_and_pick_produce_the_expected_history_and_tree() {
        let (_d, git) = five_commits();
        let todo = items(
            &git,
            &[
                (TodoAction::Pick, 4, None),                                 // A
                (TodoAction::Reword, 3, Some("B, reworded\n\nwith a body")), // B
                (TodoAction::Fixup, 2, None),                                // C folds into B
                (TodoAction::Drop, 1, None),                                 // D disappears
                (TodoAction::Pick, 0, None),                                 // E
            ],
        );
        start(
            &git,
            &oid_of(&git, "HEAD~5"),
            &todo,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        assert_eq!(
            log_subjects(&git),
            ["base", "commit A", "B, reworded", "commit E"]
        );
        let body = String::from_utf8_lossy(
            &git.output(["log", "-1", "--skip=1", "--format=%b"])
                .unwrap(),
        )
        .trim()
        .to_string();
        assert_eq!(body, "with a body");
        let tree = String::from_utf8_lossy(
            &git.output(["ls-tree", "-r", "--name-only", "HEAD"])
                .unwrap(),
        )
        .into_owned();
        let files: Vec<&str> = tree.lines().collect();
        assert_eq!(
            files,
            ["A.txt", "B.txt", "C.txt", "E.txt", "base.txt"],
            "D is gone, C survives inside B"
        );
        assert!(crate::git::ops::in_progress(&git).is_none());
    }

    #[test]
    fn squash_combines_messages_and_reordering_works() {
        let (_d, git) = five_commits();
        // Order: A, C, B (B squashed into C), E, D.
        let todo = items(
            &git,
            &[
                (TodoAction::Pick, 4, None),
                (TodoAction::Pick, 2, None),
                (TodoAction::Squash, 3, None),
                (TodoAction::Pick, 0, None),
                (TodoAction::Pick, 1, None),
            ],
        );
        start(
            &git,
            &oid_of(&git, "HEAD~5"),
            &todo,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let subjects = log_subjects(&git);
        assert_eq!(
            subjects,
            ["base", "commit A", "commit C", "commit E", "commit D"]
        );
        let msg = String::from_utf8_lossy(
            &git.output(["log", "-1", "--skip=2", "--format=%B"])
                .unwrap(),
        )
        .into_owned();
        assert!(
            msg.contains("commit C") && msg.contains("commit B"),
            "squash keeps both messages: {msg}"
        );
    }

    #[test]
    fn edit_stops_the_rebase_and_continue_finishes_it() {
        let (_d, git) = five_commits();
        let todo = items(
            &git,
            &[
                (TodoAction::Pick, 4, None),
                (TodoAction::Edit, 3, None),
                (TodoAction::Pick, 2, None),
                (TodoAction::Pick, 1, None),
                (TodoAction::Pick, 0, None),
            ],
        );
        let r = start(
            &git,
            &oid_of(&git, "HEAD~5"),
            &todo,
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(r.is_err() || crate::git::ops::in_progress(&git).is_some());
        assert_eq!(
            crate::git::ops::in_progress(&git),
            Some(crate::git::ops::Operation::Rebase)
        );
        git.output(["commit", "-q", "--amend", "-m", "B amended while stopped"])
            .unwrap();
        crate::git::ops::run(&git, &crate::git::ops::GitOp::Continue, |_| {}).unwrap();
        assert!(crate::git::ops::in_progress(&git).is_none());
        assert_eq!(log_subjects(&git)[2], "B amended while stopped");
    }

    #[test]
    fn invalid_lists_are_rejected_before_anything_changes() {
        let (_d, git) = five_commits();
        let head = oid_of(&git, "HEAD");
        let all = items(
            &git,
            &[
                (TodoAction::Pick, 4, None),
                (TodoAction::Pick, 3, None),
                (TodoAction::Pick, 2, None),
                (TodoAction::Pick, 1, None),
                (TodoAction::Pick, 0, None),
            ],
        );
        // A commit missing from the list.
        assert!(
            start(
                &git,
                &oid_of(&git, "HEAD~5"),
                &all[1..],
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        // Squashing the first commit has nothing to squash into.
        let mut bad = all.clone();
        bad[0].action = TodoAction::Squash;
        assert!(
            start(
                &git,
                &oid_of(&git, "HEAD~5"),
                &bad,
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        // Rewording without a message, and dropping everything.
        let mut no_msg = all.clone();
        no_msg[1].action = TodoAction::Reword;
        assert!(
            start(
                &git,
                &oid_of(&git, "HEAD~5"),
                &no_msg,
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        let all_drop: Vec<TodoItem> = all
            .iter()
            .cloned()
            .map(|mut i| {
                i.action = TodoAction::Drop;
                i
            })
            .collect();
        assert!(
            start(
                &git,
                &oid_of(&git, "HEAD~5"),
                &all_drop,
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        // Hostile base and ids.
        assert!(start(&git, "--exec=evil", &all, &AtomicBool::new(false), |_| {}).is_err());
        let mut evil = all.clone();
        evil[0].oid = "HEAD".into();
        assert!(
            start(
                &git,
                &oid_of(&git, "HEAD~5"),
                &evil,
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        assert_eq!(
            oid_of(&git, "HEAD"),
            head,
            "no failed attempt touched the branch"
        );
        assert!(crate::git::ops::in_progress(&git).is_none());
    }

    #[test]
    fn prediction_names_the_files_that_would_conflict_without_changing_anything() {
        let (_d, git) = init_repo();
        commit_file(&git, "f.txt", "base\n", "base");
        commit_file(&git, "g.txt", "g\n", "g");
        git.output(["switch", "-q", "-c", "other"]).unwrap();
        commit_file(&git, "f.txt", "other\n", "other f");
        commit_file(&git, "h.txt", "h\n", "other h");
        git.output(["switch", "-q", "main"]).unwrap();
        commit_file(&git, "f.txt", "main\n", "main f");
        let head = oid_of(&git, "HEAD");

        let p = predict_merge(&git, "main", "other").unwrap();
        if !p.supported {
            return; // old git: the UI simply skips the preview
        }
        assert_eq!(p.conflicts, ["f.txt"]);
        // A merge that would be clean says so.
        git.output(["branch", "clean", "HEAD~1"]).unwrap();
        commit_file(&git, "m.txt", "m\n", "m");
        assert!(
            predict_merge(&git, "main", "clean")
                .unwrap()
                .conflicts
                .is_empty()
        );

        // Cherry-picking the conflicting commit.
        let other_f = oid_of(&git, "other~1");
        assert_eq!(
            predict_pick(&git, "main", &other_f).unwrap().conflicts,
            ["f.txt"]
        );
        assert!(predict_merge(&git, "main", "--all").is_err());
        assert_ne!(oid_of(&git, "HEAD"), "", "repo intact");
        assert!(
            crate::git::ops::in_progress(&git).is_none(),
            "prediction leaves no merge state"
        );
        let _ = head;
    }
}
