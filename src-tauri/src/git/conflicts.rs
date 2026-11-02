//! Merge conflicts: which files are conflicted and how, the three versions of each (base, ours,
//! theirs) merged into segments the UI can resolve one by one, and writing the resolution back.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    /// We deleted the file; they changed it.
    DeletedByUs,
    /// They deleted the file; we changed it.
    DeletedByThem,
    AddedByUs,
    AddedByThem,
    BothDeleted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
}

fn kind_of(stages: [bool; 3]) -> ConflictKind {
    match stages {
        [true, true, true] => ConflictKind::BothModified,
        [false, true, true] => ConflictKind::BothAdded,
        [true, false, true] => ConflictKind::DeletedByUs,
        [true, true, false] => ConflictKind::DeletedByThem,
        [false, true, false] => ConflictKind::AddedByUs,
        [false, false, true] => ConflictKind::AddedByThem,
        _ => ConflictKind::BothDeleted,
    }
}

/// Unmerged paths, from the index's stage entries.
pub fn list(git: &Git) -> Result<Vec<ConflictFile>> {
    let out = git.output(["ls-files", "-u", "-z"])?;
    let mut files: Vec<(String, [bool; 3])> = Vec::new();
    for entry in out.split(|&b| b == 0).filter(|e| !e.is_empty()) {
        // `<mode> <oid> <stage>\t<path>`
        let text = String::from_utf8_lossy(entry);
        let Some((meta, path)) = text.split_once('\t') else {
            continue;
        };
        let Some(stage) = meta
            .rsplit(' ')
            .next()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            continue;
        };
        if !(1..=3).contains(&stage) {
            continue;
        }
        match files.iter_mut().find(|(p, _)| p == path) {
            Some((_, s)) => s[stage - 1] = true,
            None => {
                let mut s = [false; 3];
                s[stage - 1] = true;
                files.push((path.to_string(), s));
            }
        }
    }
    Ok(files
        .into_iter()
        .map(|(path, stages)| ConflictFile {
            path,
            kind: kind_of(stages),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Segment {
    /// Lines both sides agree on (or that only one side changed): already merged.
    Text { text: String },
    /// Lines the two sides changed differently.
    Conflict {
        ours: String,
        base: Option<String>,
        theirs: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictDetail {
    pub path: String,
    pub kind: ConflictKind,
    /// Binary files cannot be merged line by line: choose a whole side.
    pub binary: bool,
    /// Empty for binary files and for conflicts where a side deleted the file.
    pub segments: Vec<Segment>,
    /// Each side's full text, `None` when that side has no version (deleted or not yet added).
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub base: Option<String>,
}

fn stage_blob(git: &Git, stage: u8, path: &str) -> Option<Vec<u8>> {
    git.output(["show", &format!(":{stage}:{path}")]).ok()
}

/// Parses the output of `git merge-file --diff3`: `<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`.
pub fn parse_markers(merged: &str) -> Vec<Segment> {
    #[derive(PartialEq)]
    enum Mode {
        Plain,
        Ours,
        Base,
        Theirs,
    }
    let mut segments = Vec::new();
    let mut plain = String::new();
    let (mut ours, mut base, mut theirs) = (String::new(), String::new(), String::new());
    let mut has_base = false;
    let mut mode = Mode::Plain;

    for line in merged.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        match mode {
            Mode::Plain if bare.starts_with("<<<<<<< ") || bare == "<<<<<<<" => {
                if !plain.is_empty() {
                    segments.push(Segment::Text {
                        text: std::mem::take(&mut plain),
                    });
                }
                mode = Mode::Ours;
                has_base = false;
            }
            Mode::Ours if bare.starts_with("||||||| ") || bare == "|||||||" => {
                mode = Mode::Base;
                has_base = true;
            }
            Mode::Ours | Mode::Base if bare == "=======" => mode = Mode::Theirs,
            Mode::Theirs if bare.starts_with(">>>>>>> ") || bare == ">>>>>>>" => {
                segments.push(Segment::Conflict {
                    ours: std::mem::take(&mut ours),
                    base: has_base.then(|| std::mem::take(&mut base)),
                    theirs: std::mem::take(&mut theirs),
                });
                base.clear();
                mode = Mode::Plain;
            }
            Mode::Plain => plain.push_str(line),
            Mode::Ours => ours.push_str(line),
            Mode::Base => base.push_str(line),
            Mode::Theirs => theirs.push_str(line),
        }
    }
    if !plain.is_empty() {
        segments.push(Segment::Text { text: plain });
    }
    segments
}

pub fn detail(git: &Git, path: &str) -> Result<ConflictDetail> {
    let path = validate::rel_path(path)?;
    let file = list(git)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| AppError::Git("that file is not in conflict".into()))?;

    let base = stage_blob(git, 1, path);
    let ours = stage_blob(git, 2, path);
    let theirs = stage_blob(git, 3, path);
    let binary = [&base, &ours, &theirs].iter().any(|b| {
        b.as_ref()
            .is_some_and(|b| b.contains(&0) || std::str::from_utf8(b).is_err())
    });
    let text = |b: &Option<Vec<u8>>| b.as_ref().map(|b| String::from_utf8_lossy(b).into_owned());

    let mut segments = Vec::new();
    if !binary && ours.is_some() && theirs.is_some() {
        // `git merge-file` does the three-way merge; its exit status is the number of conflicts.
        let dir = std::env::temp_dir().join(format!("perseus-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(AppError::git)?;
        let write = |name: &str, bytes: &[u8]| -> Result<String> {
            let p = dir.join(name);
            std::fs::write(&p, bytes).map_err(AppError::git)?;
            Ok(p.to_string_lossy().into_owned())
        };
        let result = (|| {
            let o = write("ours", ours.as_deref().unwrap_or_default())?;
            let b = write("base", base.as_deref().unwrap_or_default())?;
            let t = write("theirs", theirs.as_deref().unwrap_or_default())?;
            let ok_codes: Vec<i32> = (0..=127).collect();
            git.output_allowing(
                [
                    "merge-file",
                    "-p",
                    "--diff3",
                    "-L",
                    "ours",
                    "-L",
                    "base",
                    "-L",
                    "theirs",
                    &o,
                    &b,
                    &t,
                ],
                &ok_codes,
            )
        })();
        let _ = std::fs::remove_dir_all(&dir);
        segments = parse_markers(&String::from_utf8_lossy(&result?));
    }

    Ok(ConflictDetail {
        path: file.path,
        kind: file.kind,
        binary,
        segments,
        ours: text(&ours),
        theirs: text(&theirs),
        base: text(&base),
    })
}

#[derive(Debug, Deserialize)]
#[serde(tag = "how", rename_all = "snake_case")]
pub enum Resolution {
    /// The final text of the file, as composed in the editor.
    Content { text: String },
    /// Keep our whole version (removes the file when our side deleted it).
    Ours,
    /// Take their whole version (removes the file when their side deleted it).
    Theirs,
    /// The file ends up deleted.
    Delete,
}

pub fn resolve(git: &Git, path: &str, how: &Resolution) -> Result<()> {
    let path = validate::rel_path(path)?;
    let file = list(git)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| AppError::Git("that file is not in conflict".into()))?;
    let has = |stage: u8| stage_blob(git, stage, path).is_some();

    match how {
        Resolution::Content { text } => {
            if text.contains('\0') {
                return Err(AppError::Git(
                    "the resolved text contains a NUL byte".into(),
                ));
            }
            std::fs::write(git.root().join(path), text).map_err(AppError::git)?;
            git.output(["add", "--", path])?;
        }
        Resolution::Ours | Resolution::Theirs => {
            let (flag, stage) = if matches!(how, Resolution::Ours) {
                ("--ours", 2)
            } else {
                ("--theirs", 3)
            };
            if has(stage) {
                git.output(["checkout", flag, "--", path])?;
                git.output(["add", "--", path])?;
            } else {
                git.output(["rm", "-q", "--", path])?;
            }
        }
        Resolution::Delete => {
            git.output(["rm", "-q", "--", path])?;
        }
    }
    let _ = file;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    /// main and `other` both start from `base` and diverge on the given files; then merge `other`.
    fn conflicted(
        base: &[(&str, &str)],
        main: &[(&str, &str)],
        other: &[(&str, &str)],
    ) -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        for (f, c) in base {
            write(&git, f, c);
        }
        git.output(["add", "-A"]).unwrap();
        git.output(["commit", "-q", "-m", "base", "--allow-empty"])
            .unwrap();
        git.output(["switch", "-q", "-c", "other"]).unwrap();
        for (f, c) in other {
            if c.is_empty() {
                git.output(["rm", "-q", f]).unwrap();
            } else {
                write(&git, f, c);
            }
        }
        git.output(["add", "-A"]).unwrap();
        git.output(["commit", "-q", "-m", "other", "--allow-empty"])
            .unwrap();
        git.output(["switch", "-q", "main"]).unwrap();
        for (f, c) in main {
            if c.is_empty() {
                git.output(["rm", "-q", f]).unwrap();
            } else {
                write(&git, f, c);
            }
        }
        git.output(["add", "-A"]).unwrap();
        git.output(["commit", "-q", "-m", "main", "--allow-empty"])
            .unwrap();
        let _ = git.output(["merge", "other"]); // conflicts
        (d, git)
    }

    #[test]
    fn marker_parser_splits_text_and_conflicts_with_and_without_a_base() {
        let merged = "head\n<<<<<<< ours\nmine\n||||||| base\norig\n=======\ntheirs\n>>>>>>> theirs\nmiddle\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\ntail";
        let s = parse_markers(merged);
        assert_eq!(s.len(), 5);
        assert_eq!(
            s[0],
            Segment::Text {
                text: "head\n".into()
            }
        );
        assert_eq!(
            s[1],
            Segment::Conflict {
                ours: "mine\n".into(),
                base: Some("orig\n".into()),
                theirs: "theirs\n".into()
            }
        );
        assert_eq!(
            s[2],
            Segment::Text {
                text: "middle\n".into()
            }
        );
        assert_eq!(
            s[3],
            Segment::Conflict {
                ours: "a\n".into(),
                base: None,
                theirs: "b\n".into()
            }
        );
        assert_eq!(
            s[4],
            Segment::Text {
                text: "tail".into()
            }
        );
        // No markers: one text segment, byte for byte.
        assert_eq!(
            parse_markers("a\r\nb\r\n"),
            vec![Segment::Text {
                text: "a\r\nb\r\n".into()
            }]
        );
        assert!(parse_markers("").is_empty());
    }

    #[test]
    fn lists_kinds_for_every_flavour_of_conflict() {
        let (_d, git) = conflicted(
            &[
                ("both.txt", "1\n"),
                ("del_us.txt", "1\n"),
                ("del_them.txt", "1\n"),
            ],
            &[
                ("both.txt", "main\n"),
                ("del_us.txt", ""),
                ("del_them.txt", "main\n"),
                ("add.txt", "main\n"),
            ],
            &[
                ("both.txt", "other\n"),
                ("del_us.txt", "other\n"),
                ("del_them.txt", ""),
                ("add.txt", "other\n"),
            ],
        );
        let kinds: std::collections::HashMap<_, _> = list(&git)
            .unwrap()
            .into_iter()
            .map(|f| (f.path, f.kind))
            .collect();
        assert_eq!(kinds["both.txt"], ConflictKind::BothModified);
        assert_eq!(kinds["add.txt"], ConflictKind::BothAdded);
        assert_eq!(kinds["del_us.txt"], ConflictKind::DeletedByUs);
        assert_eq!(kinds["del_them.txt"], ConflictKind::DeletedByThem);
    }

    #[test]
    fn detail_merges_cleanly_changed_parts_and_isolates_the_real_conflict() {
        let base: String = (1..=12).map(|i| format!("line {i}\n")).collect();
        let main = base
            .replace("line 2\n", "main 2\n")
            .replace("line 6\n", "main 6\n");
        let other = base
            .replace("line 6\n", "other 6\n")
            .replace("line 11\n", "other 11\n");
        let (_d, git) = conflicted(
            &[("f.txt", &base)],
            &[("f.txt", &main)],
            &[("f.txt", &other)],
        );

        let d = detail(&git, "f.txt").unwrap();
        assert_eq!(d.kind, ConflictKind::BothModified);
        assert!(!d.binary);
        let conflicts: Vec<_> = d
            .segments
            .iter()
            .filter(|s| matches!(s, Segment::Conflict { .. }))
            .collect();
        assert_eq!(
            conflicts.len(),
            1,
            "only line 6 conflicts: {:?}",
            d.segments
        );
        match conflicts[0] {
            Segment::Conflict {
                ours, theirs, base, ..
            } => {
                assert_eq!(ours, "main 6\n");
                assert_eq!(theirs, "other 6\n");
                assert_eq!(base.as_deref(), Some("line 6\n"));
            }
            Segment::Text { .. } => unreachable!(),
        }
        // Changes made on one side only are already in the surrounding text.
        let text: String = d
            .segments
            .iter()
            .filter_map(|s| {
                if let Segment::Text { text } = s {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert!(text.contains("main 2\n") && text.contains("other 11\n"));
        assert_eq!(d.ours.as_deref(), Some(main.as_str()));
        assert_eq!(d.theirs.as_deref(), Some(other.as_str()));
    }

    #[test]
    fn resolving_with_composed_content_stages_the_file() {
        let (_d, git) = conflicted(
            &[("f.txt", "a\nb\nc\n")],
            &[("f.txt", "a\nMAIN\nc\n")],
            &[("f.txt", "a\nOTHER\nc\n")],
        );
        resolve(
            &git,
            "f.txt",
            &Resolution::Content {
                text: "a\nMAIN and OTHER\nc\n".into(),
            },
        )
        .unwrap();
        assert!(list(&git).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(git.root().join("f.txt")).unwrap(),
            "a\nMAIN and OTHER\nc\n"
        );
        // The merge can now be committed.
        git.output(["commit", "-q", "--no-edit"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&git.output(["status", "--porcelain"]).unwrap()).trim(),
            ""
        );
    }

    #[test]
    fn taking_a_whole_side_and_the_delete_modify_cases() {
        let (_d, git) = conflicted(
            &[
                ("a.txt", "1\n"),
                ("gone_us.txt", "1\n"),
                ("gone_them.txt", "1\n"),
            ],
            &[
                ("a.txt", "main\n"),
                ("gone_us.txt", ""),
                ("gone_them.txt", "main\n"),
            ],
            &[
                ("a.txt", "other\n"),
                ("gone_us.txt", "other\n"),
                ("gone_them.txt", ""),
            ],
        );
        resolve(&git, "a.txt", &Resolution::Theirs).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.root().join("a.txt")).unwrap(),
            "other\n"
        );

        // We deleted it and they changed it: keeping "ours" means it stays deleted...
        resolve(&git, "gone_us.txt", &Resolution::Ours).unwrap();
        assert!(!git.root().join("gone_us.txt").exists());
        // ...and they deleted it while we changed it: taking "ours" keeps our file.
        resolve(&git, "gone_them.txt", &Resolution::Ours).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.root().join("gone_them.txt")).unwrap(),
            "main\n"
        );
        assert!(list(&git).unwrap().is_empty());
    }

    #[test]
    fn binary_conflicts_offer_whole_sides_only() {
        let (d, git) = init_repo();
        std::fs::write(d.path().join("b.bin"), b"\x00base").unwrap();
        git.output(["add", "-A"]).unwrap();
        git.output(["commit", "-q", "-m", "base"]).unwrap();
        git.output(["switch", "-q", "-c", "other"]).unwrap();
        std::fs::write(d.path().join("b.bin"), b"\x00other").unwrap();
        git.output(["commit", "-qam", "other"]).unwrap();
        git.output(["switch", "-q", "main"]).unwrap();
        std::fs::write(d.path().join("b.bin"), b"\x00main").unwrap();
        git.output(["commit", "-qam", "main"]).unwrap();
        let _ = git.output(["merge", "other"]);

        let det = detail(&git, "b.bin").unwrap();
        assert!(det.binary && det.segments.is_empty());
        resolve(&git, "b.bin", &Resolution::Ours).unwrap();
        assert_eq!(std::fs::read(d.path().join("b.bin")).unwrap(), b"\x00main");
    }

    #[test]
    fn refuses_files_that_are_not_in_conflict_and_bad_paths() {
        let (_d, git) = conflicted(
            &[("f.txt", "a\n")],
            &[("f.txt", "m\n")],
            &[("f.txt", "o\n")],
        );
        write(&git, "clean.txt", "x\n");
        assert!(detail(&git, "clean.txt").is_err());
        assert!(resolve(&git, "clean.txt", &Resolution::Delete).is_err());
        assert!(detail(&git, "../f.txt").is_err());
        assert!(resolve(&git, "../f.txt", &Resolution::Content { text: "x".into() }).is_err());
        assert!(
            resolve(
                &git,
                "f.txt",
                &Resolution::Content {
                    text: "a\0b".into()
                }
            )
            .is_err()
        );
        assert_eq!(
            list(&git).unwrap().len(),
            1,
            "nothing was resolved by the failed attempts"
        );
    }
}
