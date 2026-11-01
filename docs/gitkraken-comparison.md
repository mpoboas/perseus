# Perseus vs GitKraken Desktop

Researched 2026-11-01 against GitKraken Desktop's official documentation, pricing page and
release notes (the installed copy on this machine is **12.6.1**; I confirmed the version from
the binary but could not tour its UI, because its window was minimized and I only had
click-only access). Perseus status is from this repository at commit `5c67a33`.

**Legend.** Perseus: ✅ have · 🟡 partial · ❌ missing · ➕ Perseus-only advantage.
GitKraken tier: **Free** = Community plan, **Pro+** = paid. GitKraken's free plan only covers
*local repos and public remotes*; several headline features are tagged "Public Repos Only" on
free, which is the paywall Perseus was built to avoid.

## Where Perseus stands

Perseus covers the **daily core loop** (see history, stage, commit, branch, merge, rebase,
cherry-pick, fetch/pull/push, switch identity) and is ahead on cost, privacy and weight. It
is **not at parity**: GitKraken has roughly a decade of features around that loop (interactive
rebase, a conflict editor, hunk/line staging, stash, tags, undo, search, pull requests,
issue tracking, workspaces, AI, a terminal). Section 3 ranks what to build.

---

## 1. Feature matrix

### Repository management
| Feature | GitKraken | Perseus |
|---|---|---|
| Open a local repository | Free | ✅ native folder picker |
| Clone / init | Free | ❌ |
| Multiple repos as tabs, per-profile tab sets, tab aliases | Free | ❌ one repo at a time |
| Favorites / recent repos | Free | ❌ |
| Fork a GitHub repo from the app | Free | ❌ |
| Repo maintenance (gc etc.), activity log | Free | ❌ (errors show in the toolbar only) |
| Deep links (open a repo/commit from a URL) | Free | ❌ |
| Open in terminal / file manager / IDE | Free | ❌ |

### Commit graph and history
| Feature | GitKraken | Perseus |
|---|---|---|
| Visual commit graph with lanes, merge nodes, ref badges | Free | ✅ canvas, virtualized, streamed |
| Handles very large histories | Slow reports on huge repos (Electron) | ✅ ➕ Rust + streaming; 100k commits walk ~2 s (graph scroll FPS not measured) |
| Ghost branches (show a commit's containing branch) | Free | ❌ |
| Hover highlight of a branch's commits | Free | ❌ |
| Hover tooltip with commit details | Free | ✅ |
| Configurable columns (author, date, sha), resize/reorder, saved per repo | Free | 🟡 fixed columns (refs, summary, author, date) |
| Filter by author / team | Free | ❌ |
| Hide and solo branches/tags/remotes | Free | ❌ |
| Search commits by message, sha, author | Free | ❌ |
| Keyboard navigation of the graph | Free | ✅ arrows, page, home/end |
| Selected-commit detail (message, ids, parents, files) | Free | ✅ |
| Jump to parent commit | Free | ✅ |

### Diff, blame, files
| Feature | GitKraken | Perseus |
|---|---|---|
| Unified diff view | Free | ✅ virtualized, 4 MiB cap, no-exec-diff safety |
| Side-by-side / split diff, word-level highlights | Free | ❌ |
| Syntax highlighting | Free | ❌ |
| File history | Free | ❌ |
| Blame | Free | ❌ |
| Edit and save a file from the diff | Free | ❌ |
| Binary/image diff | Free | ❌ ("Binary files differ" text only) |
| Create / apply patches | Free | ❌ |
| Cloud Patches (share a patch without a PR) | Pro | ❌ |

### Staging and committing
| Feature | GitKraken | Perseus |
|---|---|---|
| Stage / unstage files | Free | ✅ (single or all) |
| Stage / unstage / discard **hunks and lines** | Free | ❌ file-level only |
| Discard changes | Free | ❌ |
| Commit with summary + description | Free | ✅ (one message box) |
| Amend last commit | Free | ✅ (message must be retyped) |
| Commit templates, conventional-commit helpers | Free | ❌ |
| Commit author from active profile | Pro (multiple profiles) | ✅ ➕ |
| GPG / SSH commit signing | Free (public) | ❌ |
| Git hooks run on commit / merge / rebase | Free | 🟡 hooks run (git does it) but no UI or skip option |
| Co-author handling | Free | ❌ |

### Branching, merging, rebasing
| Feature | GitKraken | Perseus |
|---|---|---|
| Create / check out branches (incl. remote → tracking) | Free | ✅ |
| Rename / delete branch | Free | ❌ |
| Merge | Free | ✅ menu + drag-and-drop + confirm |
| Rebase onto a branch/commit | Free | ✅ (non-interactive, warns about history rewrite) |
| **Interactive rebase** (reorder, reword, squash, drop) | Free for public repos only | ❌ |
| Squash commits | Free | ❌ |
| Cherry-pick one commit | Free | ✅ menu + drag-and-drop |
| Cherry-pick several commits with reorder/squash | Free | ❌ |
| Revert a commit | Free | ❌ |
| Reset (soft/mixed/hard) to a commit | Free | ❌ |
| Drag-and-drop branch operations | Free | ✅ ➕ explicit rules and refusal messages |
| Detached HEAD checkout | Free | ✅ |
| Gitflow (start/finish features, releases, hotfixes) | Free for public repos only | ❌ |
| Undo / redo of Git actions | Free | ❌ |
| Conflict-state banner with abort / continue | Free | ✅ |

### Conflict resolution
| Feature | GitKraken | Perseus |
|---|---|---|
| Built-in merge tool (side-by-side with live output, per-line picks) | Free | ❌ (mark resolved only; edit externally) |
| Open conflicts in external tools (Beyond Compare, P4Merge…) | Free | ❌ |
| Conflict Prevention (warn about likely conflicts early) | Pro | ❌ |
| AI conflict resolution | Paid | ❌ |

### Remotes and sync
| Feature | GitKraken | Perseus |
|---|---|---|
| Fetch (all), pull, push | Free | ✅ with live progress |
| Pull variants (ff, ff-only, rebase), default pull type | Free | 🟡 fast-forward only |
| Push options (force-with-lease, tags, set upstream) | Free | 🟡 set-upstream only; no force |
| Manage remotes (add/remove/rename) | Free | ❌ |
| Cancel a running network operation | Free | ❌ |
| Auto-fetch in the background | Free | ❌ (status refreshes on window focus) |
| Ahead/behind counts | Free | ✅ |

### Stash, tags, submodules, worktrees, LFS
| Feature | GitKraken | Perseus |
|---|---|---|
| Stash, pop, apply, list in sidebar | Free | ❌ |
| Create (annotated) tags, push/delete tags | Free | ❌ (lists tags, can check out) |
| Submodules (add, update, list) | Free | ❌ |
| Worktrees (create, open, remove, graph indicator) | Free for public repos only | ❌ |
| Git LFS | Free for public repos only | 🟡 works only through the installed `git`; no UI |

### Identity, authentication, profiles
| Feature | GitKraken | Perseus |
|---|---|---|
| Multiple profiles (name, email, integrations, preferences) | **Pro** | ✅ ➕ free, unlimited |
| Per-profile SSH key, offered exclusively | — | ✅ ➕ `IdentitiesOnly` |
| Per-profile tokens kept in the OS keychain | Account-synced | ✅ ➕ local only, never in files |
| Profile applied without editing `~/.gitconfig` | Optional sync into it | ✅ ➕ command-line overrides only |
| Per-repository profile assignment | not documented | ❌ one global active profile |
| OAuth sign-in: GitHub, GitLab (incl. self-managed host) | Free | ✅ device flow, tokens auto-refresh |
| OAuth / integration: Bitbucket, Azure DevOps | Free | ❌ (paste a token) |
| GitHub Enterprise / Bitbucket Data Center | Advanced+ | 🟡 GitHub Enterprise host + client id; others ❌ |
| One-click SSH key generation | Free | ❌ |
| Requires a vendor account to use the app | Yes | ➕ no account, no login |

### Hosting integrations
| Feature | GitKraken | Perseus |
|---|---|---|
| Pull requests: list, filter, create, review, merge | Free (cloud hosts) | ❌ |
| PR filter syntax, saved views | Free | ❌ |
| Issues from GitHub / GitLab / Jira / Trello | Pro for Jira/Trello | ❌ |
| CI / GitHub Actions workflows | Free | ❌ |
| Browser extension | Free | ❌ |

### Collaboration and planning
| Feature | GitKraken | Perseus |
|---|---|---|
| Launchpad (PRs, issues, WIP by status) | Pro | ❌ |
| Workspaces (group repos; multi-repo fetch) | Local free, Cloud Pro | ❌ |
| Team view (what teammates are working on) | Account | ❌ |
| Code Suggest, DORA / Insights, Boards | Paid | ❌ out of scope |

### AI and agents
| Feature | GitKraken | Perseus |
|---|---|---|
| AI commit message / stash message / PR text | Paid (credits) | ❌ |
| AI commit explanation, Commit Composer | Paid | ❌ |
| Coding-agent sessions on worktrees, integrated terminal | Public repos free | ❌ |
| Kepler (multi-repo agent workspace, separate product) | Preview | ❌ out of scope |
| Bring-your-own model key | Pro | ❌ |

### Productivity and interface
| Feature | GitKraken | Perseus |
|---|---|---|
| Command palette (Ctrl+P: checkout, branch, search, stash, patch…) | Free | ❌ |
| Customizable keyboard shortcuts | Free | ❌ (fixed) |
| Themes, UI zoom, preferences screens | Free | ❌ follows the OS dark/light setting only |
| Integrated terminal | Public repos free | ❌ |
| Right-click context menus | Free | 🟡 graph only |
| Hover/drag feedback and confirm dialogs | Free | ✅ |
| Auto-update, installers | Free | ❌ dev builds only |

### Security, privacy, footprint
| Aspect | GitKraken | Perseus |
|---|---|---|
| Source available / auditable | Closed | ➕ open |
| Cost for private repos | Pro seat | ➕ free |
| Network calls other than your git remotes | Account, sync, AI, telemetry (per their docs) | ➕ none besides the OAuth provider you pick |
| Tokens at rest | Account-synced integrations | ➕ OS keychain only |
| Webview/IPC hardening | Not documented | ➕ isolation pattern, strict CSP, command allowlist |
| Never runs repo-configured diff/textconv programs | not documented | ➕ enforced and tested |
| Runtime | Electron | ➕ Tauri + native Rust core |
| Platforms | Windows, macOS, Linux | 🟡 Windows verified; macOS/Linux compile in CI only |

---

## 2. What the numbers say

Counting the 109 rows above: Perseus has **35 ✅ or ➕**, **8 🟡**, and **66 ❌**. Roughly ten
of the ❌ rows are deliberately out of scope (Kepler, Insights, Boards, team services, the
vendor-account features); the rest are real gaps, ranked below.

## 3. Suggested build order

**Tier 1: expected by anyone switching from a Git GUI** (each is days, not weeks)
1. **Stash** (create, apply, pop, drop, list in sidebar) and **tag creation/deletion**.
2. **Hunk and line staging**, plus **discard changes**: a core staging feature, uses `git apply --cached`.
3. **Commit search** and an author filter; **hide / solo** refs.
4. **Delete / rename branch**, **revert**, **reset**, and push options (**force-with-lease**, tags).
5. **Clone and init**, recent-repos list, repo tabs.
6. **Undo** for local ref moves (reflog-based).
7. **Syntax highlighting and side-by-side diff**; file history and blame.

**Tier 2: the features people actually pay GitKraken for**
8. **Merge conflict editor** (the single biggest gap in daily use).
9. **Interactive rebase** UI (reorder, reword, squash, fixup, drop): GitKraken lists no fixup/edit, so a full set would be an edge.
10. **Pull requests**: list, create, review status, for GitHub and GitLab first (the OAuth tokens are already there).
11. **Per-repository profile** assignment (the identity feature is already better than GitKraken's if it follows the repo).
12. **Commit signing** (SSH and GPG), **submodules**, **worktrees**, **LFS indicator**.

**Tier 3: polish and reach**
13. Command palette, themes, preferences, custom shortcuts.
14. Installers, auto-update, bundled credential helper, macOS/Linux verification.
15. Optional AI helpers with a bring-your-own key; an integrated terminal.

**Probably not worth chasing:** Launchpad, cloud workspaces, team view, Insights, Boards,
Kepler/agent orchestration. They depend on a vendor account and cloud backend; Perseus's
local-first, no-account design is a feature.

## 4. Caveats

- GitKraken facts come from its public docs and pricing page. The pricing page's per-plan
  check marks did not extract cleanly, so *which tier* some features need is partly inferred;
  the "Public Repos Only" tags on free are from the page text.
- I did not use GitKraken hands-on. Its 12.x line also moved heavily toward AI-agent
  workflows, so some rows (agent sessions, Kepler) are about a product direction Perseus
  does not need to follow.
- Perseus performance claims are from tests and one real measurement (1,807 commits in
  0.27 s); there is no like-for-like benchmark against GitKraken.

## Sources

- GitKraken Desktop features: https://www.gitkraken.com/git-client
- Pricing and plan comparison: https://www.gitkraken.com/pricing
- Documentation index: https://help.gitkraken.com/gitkraken-desktop/ and https://help.gitkraken.com/llms.txt
- Interface guide: https://help.gitkraken.com/start-here/interface
- Profiles: https://help.gitkraken.com/gitkraken-client/profiles/
- Command palette: https://help.gitkraken.com/gitkraken-client/command-palette/
- Worktrees: https://help.gitkraken.com/gitkraken-client/worktrees/
- Interactive rebase: https://help.gitkraken.com/gitkraken-client/interactive-rebase
- Workspaces: https://help.gitkraken.com/gitkraken-client/workspaces/
- Release notes: https://help.gitkraken.com/release-notes/current/
- Pull request filter syntax: https://help.gitkraken.com/gitkraken-desktop/pull-requests-filter-syntax/
- Kepler: https://help.gitkraken.com/kepler
- Performance complaints (reviews, anecdotal): https://thesoftwarescout.com/gitkraken-review-2026-the-best-git-gui-client-for-most-developers/
