//! Hunk and line staging: parse the unified diff of one file, build a smaller patch that contains
//! only the chosen hunks or lines, and apply it with `git apply`.
//!
//! * **Stage**   applies the selected part of the *unstaged* diff to the index (`--cached`).
//! * **Unstage** applies the selected part of the *staged* diff to the index in reverse.
//! * **Discard** applies the selected part of the *unstaged* diff to the working tree in reverse.
//!
//! The work happens on bytes, never on lossy strings, so files that are not UTF-8 (or that use
//! CRLF line endings) round-trip exactly. Because the user selected lines in a view that may be
//! stale, every selected hunk carries its header and a checksum of its lines; if the file changed
//! since the view was drawn the request is refused instead of staging the wrong lines.

use serde::Deserialize;

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::diff::{WorkSide, worktree_patch};
use crate::git::validate;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// The `@@ … @@` line exactly as git printed it (counts of 1 are omitted there).
    pub raw_header: Vec<u8>,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// Text after the closing `@@` (the function name git shows), including its leading space.
    pub section: Vec<u8>,
    /// Every line of the hunk, each starting with ` `, `+`, `-` or `\`, without the final `\n`.
    pub lines: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePatch {
    /// Everything before the first hunk (`diff --git`, `index`, `---`, `+++`, mode lines).
    pub header: Vec<Vec<u8>>,
    pub hunks: Vec<Hunk>,
}

/// FNV-1a over the hunk's lines joined with `\n`. The front end computes the same value over the
/// text it displayed.
pub fn hunk_checksum(lines: &[Vec<u8>]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            hash = (hash ^ u32::from(b'\n')).wrapping_mul(0x0100_0193);
        }
        for &b in line {
            hash = (hash ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
    }
    hash
}

fn bad(msg: &str) -> AppError {
    AppError::Git(format!("cannot read the diff: {msg}"))
}

fn parse_range(s: &[u8]) -> Option<(u32, u32)> {
    let text = std::str::from_utf8(s).ok()?;
    match text.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((text.parse().ok()?, 1)),
    }
}

/// Parses `@@ -a[,b] +c[,d] @@[ section]`.
fn parse_hunk_header(line: &[u8]) -> Option<(u32, u32, u32, u32, Vec<u8>)> {
    let rest = line.strip_prefix(b"@@ -")?;
    let end = rest.windows(3).position(|w| w == b" @@")?;
    let (ranges, after) = rest.split_at(end);
    let section = after[3..].to_vec();
    let mut parts = ranges.split(|&b| b == b' ');
    let old = parse_range(parts.next()?)?;
    let new = parse_range(parts.next()?.strip_prefix(b"+")?)?;
    Some((old.0, old.1, new.0, new.1, section))
}

pub fn parse(patch: &[u8]) -> Result<FilePatch> {
    let mut lines: Vec<&[u8]> = patch.split(|&b| b == b'\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut header = Vec::new();
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in lines {
        if line.starts_with(b"@@ ") {
            let (os, oc, ns, nc, section) =
                parse_hunk_header(line).ok_or_else(|| bad("malformed hunk header"))?;
            hunks.push(Hunk {
                raw_header: line.to_vec(),
                old_start: os,
                old_count: oc,
                new_start: ns,
                new_count: nc,
                section,
                lines: Vec::new(),
            });
        } else if let Some(h) = hunks.last_mut() {
            // A hunk is as long as its header says; anything after belongs to the next file.
            h.lines.push(line.to_vec());
        } else {
            header.push(line.to_vec());
        }
    }
    for h in &hunks {
        let old = h
            .lines
            .iter()
            .filter(|l| matches!(l.first(), Some(b' ' | b'-')))
            .count();
        let new = h
            .lines
            .iter()
            .filter(|l| matches!(l.first(), Some(b' ' | b'+')))
            .count();
        if old as u32 != h.old_count || new as u32 != h.new_count {
            return Err(bad("hunk line counts do not match its header"));
        }
    }
    Ok(FilePatch { header, hunks })
}

/// What to take from one hunk.
#[derive(Debug, Clone, Deserialize)]
pub struct HunkSelection {
    /// Index of the hunk in the file's patch.
    pub hunk: usize,
    /// The `@@ … @@` line the user saw, checked against the current diff.
    pub header: String,
    /// Checksum of the hunk's lines as displayed (see [`hunk_checksum`]).
    pub checksum: u32,
    /// Indices (into the hunk's lines) of the `+`/`-` lines to take; `None` takes the whole hunk.
    pub lines: Option<Vec<usize>>,
}

fn header_text(h: &Hunk) -> String {
    String::from_utf8_lossy(&h.raw_header).into_owned()
}

/// Builds the patch text for the selected parts. `reverse` is for patches that will be applied
/// with `-R` (unstage and discard): the roles of unselected `+` and `-` lines swap, because the
/// file being patched is then the *new* side of the diff.
pub fn build(file: &FilePatch, selection: &[HunkSelection], reverse: bool) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    for h in &file.header {
        out.extend_from_slice(h);
        out.push(b'\n');
    }

    let mut chosen: Vec<&HunkSelection> = selection.iter().collect();
    chosen.sort_by_key(|s| s.hunk);
    if chosen.windows(2).any(|w| w[0].hunk == w[1].hunk) {
        return Err(bad("a hunk was selected twice"));
    }

    let mut shift: i64 = 0;
    let mut emitted = 0;
    for sel in chosen {
        let h = file.hunks.get(sel.hunk).ok_or_else(|| {
            AppError::Git("the file changed since it was displayed; reload and try again".into())
        })?;
        if header_text(h).trim_end() != sel.header.trim_end()
            || hunk_checksum(&h.lines) != sel.checksum
        {
            return Err(AppError::Git(
                "the file changed since it was displayed; reload and try again".into(),
            ));
        }
        let wanted: Option<std::collections::HashSet<usize>> =
            sel.lines.as_ref().map(|v| v.iter().copied().collect());
        if let Some(w) = &wanted {
            for &i in w {
                match h.lines.get(i).and_then(|l| l.first()) {
                    Some(b'+' | b'-') => {}
                    _ => return Err(bad("selected a line that is not a change")),
                }
            }
        }

        let mut kept: Vec<Vec<u8>> = Vec::new();
        let (mut old_count, mut new_count) = (0u32, 0u32);
        let mut prev_dropped = false;
        for (i, line) in h.lines.iter().enumerate() {
            let selected = wanted.as_ref().is_none_or(|w| w.contains(&i));
            match line.first() {
                Some(b' ') => {
                    kept.push(line.clone());
                    old_count += 1;
                    new_count += 1;
                    prev_dropped = false;
                }
                Some(b'+') if selected => {
                    kept.push(line.clone());
                    new_count += 1;
                    prev_dropped = false;
                }
                Some(b'-') if selected => {
                    kept.push(line.clone());
                    old_count += 1;
                    prev_dropped = false;
                }
                // Not selected: the line stays as it is in the file being patched. Forward, that
                // is the old side (`-` lines remain, `+` lines never existed); reversed, it is
                // the new side (`+` lines remain, `-` lines were never there).
                Some(b'+') => {
                    if reverse {
                        let mut ctx = line.clone();
                        ctx[0] = b' ';
                        kept.push(ctx);
                        old_count += 1;
                        new_count += 1;
                        prev_dropped = false;
                    } else {
                        prev_dropped = true;
                    }
                }
                Some(b'-') => {
                    if reverse {
                        prev_dropped = true;
                    } else {
                        let mut ctx = line.clone();
                        ctx[0] = b' ';
                        kept.push(ctx);
                        old_count += 1;
                        new_count += 1;
                        prev_dropped = false;
                    }
                }
                Some(b'\\') => {
                    // "\ No newline at end of file" belongs to the line just above it.
                    if !prev_dropped {
                        kept.push(line.clone());
                    }
                }
                _ => return Err(bad("unexpected line in a hunk")),
            }
        }
        if !kept.iter().any(|l| matches!(l.first(), Some(b'+' | b'-'))) {
            continue;
        }

        // The preimage is the side of the diff that the target currently has.
        let (pre_start, pre_count, post_count) = if reverse {
            (h.new_start, new_count, old_count)
        } else {
            (h.old_start, old_count, new_count)
        };
        let post_start = (i64::from(pre_start) + shift).max(0) as u32;
        shift += i64::from(post_count) - i64::from(pre_count);
        let (os, oc, ns, nc) = if reverse {
            (post_start, post_count, pre_start, pre_count)
        } else {
            (pre_start, pre_count, post_start, post_count)
        };
        out.extend_from_slice(format!("@@ -{os},{oc} +{ns},{nc} @@").as_bytes());
        out.extend_from_slice(&h.section);
        out.push(b'\n');
        for l in kept {
            out.extend_from_slice(&l);
            out.push(b'\n');
        }
        emitted += 1;
    }
    if emitted == 0 {
        return Err(AppError::Git("nothing selected".into()));
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PatchMode {
    Stage,
    Unstage,
    Discard,
}

/// Applies the selected hunks or lines of `path`'s current diff.
pub fn apply_selection(
    git: &Git,
    path: &str,
    mode: PatchMode,
    selection: &[HunkSelection],
) -> Result<()> {
    let path = validate::rel_path(path)?;
    let side = match mode {
        PatchMode::Stage | PatchMode::Discard => WorkSide::Unstaged,
        PatchMode::Unstage => WorkSide::Staged,
    };
    let (raw, truncated) = worktree_patch(git, side, path, None)?;
    if truncated {
        return Err(AppError::Git(
            "this diff is too large to stage in parts; stage the whole file instead".into(),
        ));
    }
    let parsed = parse(&raw)?;
    let patch = build(&parsed, selection, mode != PatchMode::Stage)?;
    let args: &[&str] = match mode {
        PatchMode::Stage => &["apply", "--cached", "--recount", "--whitespace=nowarn", "-"],
        PatchMode::Unstage => &[
            "apply",
            "--cached",
            "-R",
            "--recount",
            "--whitespace=nowarn",
            "-",
        ],
        PatchMode::Discard => &["apply", "-R", "--recount", "--whitespace=nowarn", "-"],
    };
    git.output_with_stdin(args.iter().copied(), &patch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::testutil::*;

    fn all_changes(h: &Hunk) -> Vec<usize> {
        h.lines
            .iter()
            .enumerate()
            .filter(|(_, l)| matches!(l.first(), Some(b'+' | b'-')))
            .map(|(i, _)| i)
            .collect()
    }

    /// Selection for hunk `i` of the file's current diff on `side`.
    fn sel(
        git: &Git,
        side: WorkSide,
        path: &str,
        i: usize,
        lines: Option<Vec<usize>>,
    ) -> HunkSelection {
        let (raw, _) = worktree_patch(git, side, path, None).unwrap();
        let file = parse(&raw).unwrap();
        let h = &file.hunks[i];
        HunkSelection {
            hunk: i,
            header: header_text(h),
            checksum: hunk_checksum(&h.lines),
            lines,
        }
    }

    fn read(git: &Git, rel: &str) -> Vec<u8> {
        std::fs::read(git.root().join(rel)).unwrap()
    }

    fn staged(git: &Git, path: &str) -> String {
        String::from_utf8_lossy(&git.output(["show", &format!(":{path}")]).unwrap()).into_owned()
    }

    /// ten numbered lines, committed.
    fn numbered() -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        let text: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        commit_file(&git, "f.txt", &text, "base");
        (d, git)
    }

    #[test]
    fn parses_headers_hunks_and_counts() {
        let (_d, git) = numbered();
        let mut text = String::new();
        for i in 1..=30 {
            text.push_str(&match i {
                2 => "line two\n".to_string(),
                28 => "line twenty-eight\n".to_string(),
                _ => format!("line {i}\n"),
            });
        }
        write(&git, "f.txt", &text);
        let (raw, _) = worktree_patch(&git, WorkSide::Unstaged, "f.txt", None).unwrap();
        let p = parse(&raw).unwrap();
        assert_eq!(p.hunks.len(), 2);
        assert!(p.header.iter().any(|l| l.starts_with(b"+++ b/f.txt")));
        assert_eq!(p.hunks[0].old_start, 1);
        assert!(p.hunks.iter().all(|h| all_changes(h).len() == 2));
        assert!(
            parse(b"@@ -1,2 +1,2 @@\n a\n").is_err(),
            "counts must match"
        );
    }

    #[test]
    fn stages_one_hunk_and_leaves_the_other() {
        let (_d, git) = numbered();
        let mut text: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        text = text
            .replace("line 2\n", "CHANGED 2\n")
            .replace("line 28\n", "CHANGED 28\n");
        write(&git, "f.txt", &text);

        let s = sel(&git, WorkSide::Unstaged, "f.txt", 1, None);
        apply_selection(&git, "f.txt", PatchMode::Stage, &[s]).unwrap();

        let idx = staged(&git, "f.txt");
        assert!(
            idx.contains("CHANGED 28") && idx.contains("line 2\n") && !idx.contains("CHANGED 2\n")
        );
        // The working tree is untouched, and still differs from the index by the other hunk.
        assert_eq!(String::from_utf8_lossy(&read(&git, "f.txt")), text);
        let rest = git.output(["diff", "--stat"]).unwrap();
        assert!(!rest.is_empty());
    }

    #[test]
    fn stages_individual_lines_of_a_hunk() {
        let (_d, git) = init_repo();
        commit_file(&git, "g.txt", "a\nb\nc\nd\n", "base");
        // Replace b with B, insert X after c, delete d: three independent changes in one hunk.
        write(&git, "g.txt", "a\nB\nc\nX\n");
        let (raw, _) = worktree_patch(&git, WorkSide::Unstaged, "g.txt", None).unwrap();
        let file = parse(&raw).unwrap();
        assert_eq!(file.hunks.len(), 1);
        let h = &file.hunks[0];
        let idx_of = |needle: &[u8]| h.lines.iter().position(|l| l.as_slice() == needle).unwrap();

        // Take only the "+B" line (the replacement's addition) and the "-d" deletion.
        let pick = vec![idx_of(b"+B"), idx_of(b"-d")];
        let s = sel(&git, WorkSide::Unstaged, "g.txt", 0, Some(pick));
        apply_selection(&git, "g.txt", PatchMode::Stage, &[s]).unwrap();
        // "-b" stays (it was not selected), "+B" was added, "+X" absent, "d" removed.
        assert_eq!(staged(&git, "g.txt"), "a\nb\nB\nc\n");
    }

    #[test]
    fn unstages_one_line_of_a_staged_change() {
        let (_d, git) = init_repo();
        commit_file(&git, "g.txt", "a\nb\nc\n", "base");
        write(&git, "g.txt", "a\nB\nc\nD\n");
        git.output(["add", "g.txt"]).unwrap();

        let (raw, _) = worktree_patch(&git, WorkSide::Staged, "g.txt", None).unwrap();
        let file = parse(&raw).unwrap();
        let h = &file.hunks[0];
        let plus_d = h.lines.iter().position(|l| l.as_slice() == b"+D").unwrap();
        let s = sel(&git, WorkSide::Staged, "g.txt", 0, Some(vec![plus_d]));
        apply_selection(&git, "g.txt", PatchMode::Unstage, &[s]).unwrap();

        assert_eq!(
            staged(&git, "g.txt"),
            "a\nB\nc\n",
            "only the added line left the index"
        );
        assert_eq!(
            String::from_utf8_lossy(&read(&git, "g.txt")),
            "a\nB\nc\nD\n",
            "files are untouched"
        );
    }

    #[test]
    fn discards_a_hunk_from_the_working_tree_only() {
        let (_d, git) = numbered();
        let mut text: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        text = text
            .replace("line 2\n", "CHANGED 2\n")
            .replace("line 28\n", "CHANGED 28\n");
        write(&git, "f.txt", &text);

        let s = sel(&git, WorkSide::Unstaged, "f.txt", 0, None);
        apply_selection(&git, "f.txt", PatchMode::Discard, &[s]).unwrap();

        let now = String::from_utf8_lossy(&read(&git, "f.txt")).into_owned();
        assert!(now.contains("line 2\n") && now.contains("CHANGED 28"));
        assert!(
            git.output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn crlf_files_and_missing_final_newlines_round_trip() {
        let (_d, git) = init_repo();
        std::fs::write(git.root().join("w.txt"), b"one\r\ntwo\r\nthree").unwrap();
        git.output(["add", "w.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "crlf"]).unwrap();
        std::fs::write(git.root().join("w.txt"), b"one\r\nTWO\r\nthree\r\nfour").unwrap();

        let (raw, _) = worktree_patch(&git, WorkSide::Unstaged, "w.txt", None).unwrap();
        let file = parse(&raw).unwrap();
        let all: Vec<usize> = file.hunks.iter().flat_map(all_changes).collect();
        assert!(!all.is_empty());
        let s = sel(&git, WorkSide::Unstaged, "w.txt", 0, None);
        apply_selection(&git, "w.txt", PatchMode::Stage, &[s]).unwrap();
        let idx = git.output(["show", ":w.txt"]).unwrap();
        assert_eq!(
            idx, b"one\r\nTWO\r\nthree\r\nfour",
            "bytes (CRLF, no final newline) survive"
        );
    }

    #[test]
    fn non_utf8_content_survives() {
        let (_d, git) = init_repo();
        std::fs::write(git.root().join("l.txt"), b"caf\xe9\nx\n").unwrap();
        git.output(["add", "l.txt"]).unwrap();
        git.output(["commit", "-q", "-m", "latin1"]).unwrap();
        std::fs::write(git.root().join("l.txt"), b"caf\xe9\ny\n").unwrap();
        let s = sel(&git, WorkSide::Unstaged, "l.txt", 0, None);
        apply_selection(&git, "l.txt", PatchMode::Stage, &[s]).unwrap();
        assert_eq!(git.output(["show", ":l.txt"]).unwrap(), b"caf\xe9\ny\n");
    }

    #[test]
    fn refuses_when_the_file_changed_since_it_was_displayed() {
        let (_d, git) = numbered();
        let mut text: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        text = text.replace("line 2\n", "CHANGED 2\n");
        write(&git, "f.txt", &text);
        let s = sel(&git, WorkSide::Unstaged, "f.txt", 0, None);

        // Someone edits the same hunk after the user looked at it.
        write(
            &git,
            "f.txt",
            &text.replace("CHANGED 2\n", "SOMETHING ELSE\n"),
        );
        let err = apply_selection(&git, "f.txt", PatchMode::Stage, &[s]).unwrap_err();
        assert!(err.to_string().contains("changed since"), "{err}");
        assert!(
            git.output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_bad_selections() {
        let (_d, git) = numbered();
        write(
            &git,
            "f.txt",
            &(1..=30)
                .map(|i| {
                    if i == 2 {
                        "x\n".into()
                    } else {
                        format!("line {i}\n")
                    }
                })
                .collect::<String>(),
        );
        let good = sel(&git, WorkSide::Unstaged, "f.txt", 0, None);

        // A context line is not selectable.
        let (raw, _) = worktree_patch(&git, WorkSide::Unstaged, "f.txt", None).unwrap();
        let ctx = parse(&raw).unwrap().hunks[0]
            .lines
            .iter()
            .position(|l| l.first() == Some(&b' '))
            .unwrap();
        let on_context = HunkSelection {
            lines: Some(vec![ctx]),
            ..good.clone()
        };
        assert!(apply_selection(&git, "f.txt", PatchMode::Stage, &[on_context]).is_err());
        // Out of range hunk, empty selection, duplicates, traversal.
        assert!(
            apply_selection(
                &git,
                "f.txt",
                PatchMode::Stage,
                &[HunkSelection {
                    hunk: 9,
                    ..good.clone()
                }]
            )
            .is_err()
        );
        assert!(apply_selection(&git, "f.txt", PatchMode::Stage, &[]).is_err());
        assert!(
            apply_selection(
                &git,
                "f.txt",
                PatchMode::Stage,
                &[good.clone(), good.clone()]
            )
            .is_err()
        );
        assert!(apply_selection(&git, "../f.txt", PatchMode::Stage, &[good]).is_err());
    }

    #[test]
    fn checksum_matches_a_simple_reference() {
        // FNV-1a("a\nb") computed independently.
        let lines = vec![b"a".to_vec(), b"b".to_vec()];
        let mut h: u32 = 0x811c_9dc5;
        for b in b"a\nb" {
            h = (h ^ u32::from(*b)).wrapping_mul(0x0100_0193);
        }
        assert_eq!(hunk_checksum(&lines), h);
    }

    /// Tiny deterministic generator so failures reproduce.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Every hunk of the current diff, fully selected.
    fn everything(git: &Git, side: WorkSide, path: &str) -> Vec<HunkSelection> {
        let (raw, _) = worktree_patch(git, side, path, None).unwrap();
        let file = parse(&raw).unwrap();
        (0..file.hunks.len())
            .map(|i| HunkSelection {
                hunk: i,
                header: header_text(&file.hunks[i]),
                checksum: hunk_checksum(&file.hunks[i].lines),
                lines: None,
            })
            .collect()
    }

    /// A random subset of the change lines of every hunk of the current diff (never empty).
    fn random_lines(git: &Git, side: WorkSide, path: &str, rng: &mut Rng) -> Vec<HunkSelection> {
        let (raw, _) = worktree_patch(git, side, path, None).unwrap();
        let file = parse(&raw).unwrap();
        let mut picks = Vec::new();
        for (i, h) in file.hunks.iter().enumerate() {
            let changes = all_changes(h);
            let mut chosen: Vec<usize> = changes
                .iter()
                .copied()
                .filter(|_| rng.below(2) == 0)
                .collect();
            if chosen.is_empty() {
                chosen.push(changes[rng.below(changes.len())]);
            }
            picks.push(HunkSelection {
                hunk: i,
                header: header_text(h),
                checksum: hunk_checksum(&h.lines),
                lines: Some(chosen),
            });
        }
        picks
    }

    /// Whatever subset is staged first, staging the rest must make the index equal the working
    /// tree, and unstaging everything must return the index to HEAD. Together this shows that no
    /// partial patch loses or duplicates a line.
    #[test]
    fn random_partial_staging_always_composes_back() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for case in 0..24 {
            let (_d, git) = init_repo();
            let n = 8 + rng.below(20);
            let base: Vec<String> = (0..n).map(|i| format!("line {i}")).collect();
            let eol = if case % 3 == 0 { "\r\n" } else { "\n" };
            let join = |v: &[String]| v.iter().map(|l| format!("{l}{eol}")).collect::<String>();
            std::fs::write(git.root().join("r.txt"), join(&base)).unwrap();
            git.output(["add", "r.txt"]).unwrap();
            git.output(["commit", "-q", "-m", "base"]).unwrap();

            // Random edits: replace, delete, or insert after a line.
            let mut work = base.clone();
            for _ in 0..(2 + rng.below(6)) {
                if work.is_empty() {
                    break;
                }
                let at = rng.below(work.len());
                match rng.below(3) {
                    0 => work[at] = format!("edited {case}-{at}"),
                    1 => {
                        work.remove(at);
                    }
                    _ => work.insert(at, format!("inserted {case}-{at}")),
                }
            }
            let mut text = join(&work);
            if case % 4 == 0 {
                text.truncate(text.trim_end_matches(['\r', '\n']).len()); // no final newline
            }
            std::fs::write(git.root().join("r.txt"), &text).unwrap();
            if git.output(["diff", "--name-only"]).unwrap().is_empty() {
                continue; // the random edits cancelled out
            }

            let first = random_lines(&git, WorkSide::Unstaged, "r.txt", &mut rng);
            apply_selection(&git, "r.txt", PatchMode::Stage, &first)
                .unwrap_or_else(|e| panic!("case {case}: partial stage failed: {e}"));

            // Stage whatever is left.
            if !git.output(["diff", "--name-only"]).unwrap().is_empty() {
                let rest = everything(&git, WorkSide::Unstaged, "r.txt");
                apply_selection(&git, "r.txt", PatchMode::Stage, &rest)
                    .unwrap_or_else(|e| panic!("case {case}: staging the rest failed: {e}"));
            }
            assert_eq!(
                git.output(["show", ":r.txt"]).unwrap(),
                std::fs::read(git.root().join("r.txt")).unwrap(),
                "case {case}: index differs from the working tree after staging everything"
            );

            // Unstage a random subset, then the remainder: back to HEAD.
            let some = random_lines(&git, WorkSide::Staged, "r.txt", &mut rng);
            apply_selection(&git, "r.txt", PatchMode::Unstage, &some)
                .unwrap_or_else(|e| panic!("case {case}: partial unstage failed: {e}"));
            if !git
                .output(["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
            {
                let rest = everything(&git, WorkSide::Staged, "r.txt");
                apply_selection(&git, "r.txt", PatchMode::Unstage, &rest)
                    .unwrap_or_else(|e| panic!("case {case}: unstaging the rest failed: {e}"));
            }
            assert!(
                git.output(["diff", "--cached", "--name-only"])
                    .unwrap()
                    .is_empty(),
                "case {case}: the index should equal HEAD again"
            );
            // And the working tree was never touched by any of it.
            assert_eq!(
                std::fs::read(git.root().join("r.txt")).unwrap(),
                text.as_bytes(),
                "case {case}"
            );
        }
    }

    /// Discarding a random subset leaves exactly the unselected edits in the working tree.
    #[test]
    fn random_partial_discard_keeps_the_rest_of_the_edits() {
        let mut rng = Rng(0x1234_5678_9abc_def1);
        for case in 0..16 {
            let (_d, git) = init_repo();
            let base: Vec<String> = (0..16).map(|i| format!("line {i}")).collect();
            let join = |v: &[String]| v.iter().map(|l| format!("{l}\n")).collect::<String>();
            std::fs::write(git.root().join("d.txt"), join(&base)).unwrap();
            git.output(["add", "d.txt"]).unwrap();
            git.output(["commit", "-q", "-m", "base"]).unwrap();
            let mut work = base.clone();
            for _ in 0..(2 + rng.below(5)) {
                let at = rng.below(work.len());
                match rng.below(3) {
                    0 => work[at] = format!("edited {case}-{at}"),
                    1 => {
                        work.remove(at);
                    }
                    _ => work.insert(at, format!("inserted {case}-{at}")),
                }
            }
            std::fs::write(git.root().join("d.txt"), join(&work)).unwrap();
            if git.output(["diff", "--name-only"]).unwrap().is_empty() {
                continue;
            }
            let picks = random_lines(&git, WorkSide::Unstaged, "d.txt", &mut rng);
            apply_selection(&git, "d.txt", PatchMode::Discard, &picks)
                .unwrap_or_else(|e| panic!("case {case}: partial discard failed: {e}"));
            // Discarding the remainder as well must reach HEAD exactly.
            if !git.output(["diff", "--name-only"]).unwrap().is_empty() {
                let rest = everything(&git, WorkSide::Unstaged, "d.txt");
                apply_selection(&git, "d.txt", PatchMode::Discard, &rest)
                    .unwrap_or_else(|e| panic!("case {case}: discarding the rest failed: {e}"));
            }
            assert_eq!(
                std::fs::read(git.root().join("d.txt")).unwrap(),
                join(&base).as_bytes(),
                "case {case}"
            );
        }
    }
}
