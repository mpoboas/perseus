//! Commit search: by message text, author, date range and touched path, across all refs.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git::cli::Git;
use crate::git::validate;

/// Hits returned at most; the flag in [`Hits`] tells the UI there were more.
pub const MAX_HITS: usize = 2000;
const MAX_TEXT: usize = 500;

#[derive(Debug, Default, Deserialize)]
pub struct SearchQuery {
    /// Matched literally (not as a regular expression), ignoring case, against the message.
    pub text: Option<String>,
    pub author: Option<String>,
    /// `YYYY-MM-DD`, inclusive.
    pub since: Option<String>,
    pub until: Option<String>,
    /// Only commits that touched this path.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Serialize)]
pub struct Hits {
    pub hits: Vec<Hit>,
    pub truncated: bool,
}

fn clean(field: &Option<String>, what: &str) -> Result<Option<String>> {
    let Some(v) = field.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.len() > MAX_TEXT || v.contains('\0') || v.contains('\n') {
        return Err(AppError::Git(format!("invalid {what}")));
    }
    Ok(Some(v.to_string()))
}

/// `YYYY-MM-DD`, with a plausible month and day.
fn date(field: &Option<String>, what: &str) -> Result<Option<String>> {
    let Some(v) = clean(field, what)? else {
        return Ok(None);
    };
    let ok = v.len() == 10
        && v.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
        && matches!(v[5..7].parse::<u32>(), Ok(1..=12))
        && matches!(v[8..10].parse::<u32>(), Ok(1..=31));
    if ok {
        Ok(Some(v))
    } else {
        Err(AppError::Git(format!("{what} must look like 2024-03-31")))
    }
}

pub fn search(git: &Git, q: &SearchQuery) -> Result<Hits> {
    let text = clean(&q.text, "search text")?;
    let author = clean(&q.author, "author")?;
    let since = date(&q.since, "start date")?;
    let until = date(&q.until, "end date")?;
    let path = match q.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(validate::rel_path(p)?.to_string()),
        None => None,
    };
    if text.is_none() && author.is_none() && since.is_none() && until.is_none() && path.is_none() {
        return Err(AppError::Git("enter something to search for".into()));
    }

    let limit = format!("-n{}", MAX_HITS + 1);
    let mut args: Vec<String> = vec![
        "log".into(),
        "--all".into(),
        "--fixed-strings".into(),
        "--regexp-ignore-case".into(),
        "--format=%H%x00%an%x00%ct%x00%s".into(),
        limit,
    ];
    // Each value is one argument glued to its option, so it can never be read as another option.
    if let Some(t) = text {
        args.push(format!("--grep={t}"));
    }
    if let Some(a) = author {
        args.push(format!("--author={a}"));
    }
    if let Some(s) = since {
        args.push(format!("--since={s} 00:00:00"));
    }
    if let Some(u) = until {
        args.push(format!("--until={u} 23:59:59"));
    }
    if let Some(p) = path {
        args.push("--".into());
        args.push(p);
    }

    let out = git.output(args)?;
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let mut f = line.split('\0');
        let (Some(oid), Some(author), Some(time), Some(summary)) =
            (f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        hits.push(Hit {
            oid: oid.to_string(),
            author: author.to_string(),
            time: time.parse().unwrap_or(0),
            summary: summary.to_string(),
        });
    }
    let truncated = hits.len() > MAX_HITS;
    hits.truncate(MAX_HITS);
    Ok(Hits { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::GitOverrides;
    use crate::git::cli::testutil::*;

    fn commit_as(git: &Git, who: &str, date: &str, file: &str, msg: &str) {
        write(git, file, msg);
        git.output(["add", "-A"]).unwrap();
        let g = git.clone().with_overrides(GitOverrides {
            config: vec![
                ("user.name".into(), who.into()),
                ("user.email".into(), format!("{who}@x.org")),
            ],
            env: vec![
                ("GIT_AUTHOR_DATE".into(), format!("{date}T12:00:00 +0000")),
                (
                    "GIT_COMMITTER_DATE".into(),
                    format!("{date}T12:00:00 +0000"),
                ),
            ],
        });
        g.output(["commit", "-q", "-m", msg]).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, Git) {
        let (d, git) = init_repo();
        commit_as(
            &git,
            "ada",
            "2024-01-10",
            "src/a.rs",
            "Add parser for 100% of cases",
        );
        commit_as(
            &git,
            "grace",
            "2024-02-20",
            "docs/guide.md",
            "Write the Guide",
        );
        commit_as(
            &git,
            "ada",
            "2024-03-30",
            "src/b.rs",
            "Fix parser (edge case)",
        );
        git.output(["switch", "-q", "-c", "side"]).unwrap();
        commit_as(
            &git,
            "linus",
            "2024-04-02",
            "side.txt",
            "Experimental work on a side branch",
        );
        git.output(["switch", "-q", "main"]).unwrap();
        (d, git)
    }

    fn summaries(h: &Hits) -> Vec<&str> {
        h.hits.iter().map(|h| h.summary.as_str()).collect()
    }

    fn q() -> SearchQuery {
        SearchQuery::default()
    }

    #[test]
    fn matches_message_text_literally_ignoring_case_across_all_branches() {
        let (_d, git) = fixture();
        let h = search(
            &git,
            &SearchQuery {
                text: Some("PARSER".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(
            summaries(&h),
            ["Fix parser (edge case)", "Add parser for 100% of cases"]
        );
        // Regex metacharacters mean themselves.
        let h = search(
            &git,
            &SearchQuery {
                text: Some("(edge case)".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(summaries(&h), ["Fix parser (edge case)"]);
        let h = search(
            &git,
            &SearchQuery {
                text: Some("100%".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(h.hits.len(), 1);
        let h = search(
            &git,
            &SearchQuery {
                text: Some(".*".into()),
                ..q()
            },
        )
        .unwrap();
        assert!(h.hits.is_empty(), "a regex must not match everything");
        // Commits that only exist on another branch are found.
        let h = search(
            &git,
            &SearchQuery {
                text: Some("side branch".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(h.hits.len(), 1);
    }

    #[test]
    fn filters_by_author_date_range_and_path_and_combines_them() {
        let (_d, git) = fixture();
        let by = |a: &str| {
            search(
                &git,
                &SearchQuery {
                    author: Some(a.into()),
                    ..q()
                },
            )
            .unwrap()
        };
        assert_eq!(by("ada").hits.len(), 2);
        assert_eq!(by("GRACE").hits.len(), 1);

        let range = search(
            &git,
            &SearchQuery {
                since: Some("2024-02-01".into()),
                until: Some("2024-03-30".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(
            summaries(&range),
            ["Fix parser (edge case)", "Write the Guide"],
            "both ends inclusive"
        );

        let on_path = search(
            &git,
            &SearchQuery {
                path: Some("docs/guide.md".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(summaries(&on_path), ["Write the Guide"]);

        let combined = search(
            &git,
            &SearchQuery {
                text: Some("parser".into()),
                author: Some("ada".into()),
                since: Some("2024-03-01".into()),
                ..q()
            },
        )
        .unwrap();
        assert_eq!(summaries(&combined), ["Fix parser (edge case)"]);
    }

    #[test]
    fn results_carry_author_time_and_full_ids() {
        let (_d, git) = fixture();
        let h = search(
            &git,
            &SearchQuery {
                text: Some("Guide".into()),
                ..q()
            },
        )
        .unwrap();
        let hit = &h.hits[0];
        assert_eq!(hit.author, "grace");
        assert_eq!(hit.oid.len(), 40);
        assert!(hit.time > 1_700_000_000);
        assert!(!h.truncated);
    }

    #[test]
    fn rejects_empty_and_hostile_queries() {
        let (_d, git) = fixture();
        assert!(
            search(&git, &q()).is_err(),
            "an empty query would list everything"
        );
        assert!(
            search(
                &git,
                &SearchQuery {
                    text: Some("   ".into()),
                    ..q()
                }
            )
            .is_err()
        );
        for bad in [
            "2024-13-01",
            "2024-1-1",
            "yesterday",
            "2024-02-30; rm",
            "../x",
        ] {
            let r = search(
                &git,
                &SearchQuery {
                    since: Some(bad.into()),
                    ..q()
                },
            );
            assert!(r.is_err(), "{bad} accepted");
        }
        assert!(
            search(
                &git,
                &SearchQuery {
                    path: Some("../etc".into()),
                    ..q()
                }
            )
            .is_err()
        );
        assert!(
            search(
                &git,
                &SearchQuery {
                    text: Some("a\0b".into()),
                    ..q()
                }
            )
            .is_err()
        );
        assert!(
            search(
                &git,
                &SearchQuery {
                    text: Some("x".repeat(600)),
                    ..q()
                }
            )
            .is_err()
        );
        // An option-looking value is just text.
        let h = search(
            &git,
            &SearchQuery {
                text: Some("--all".into()),
                ..q()
            },
        )
        .unwrap();
        assert!(h.hits.is_empty());
        let h = search(
            &git,
            &SearchQuery {
                author: Some("--exec=evil".into()),
                ..q()
            },
        )
        .unwrap();
        assert!(h.hits.is_empty());
    }
}
