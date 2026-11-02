# Perseus vs GitKraken Desktop

Originally researched 2026-11-01 against GitKraken Desktop's official documentation, pricing page
and release notes (the installed copy on this machine is **12.6.1**; the version was confirmed
from the binary, but its UI was never toured because its window was minimized and only click
access was available). **Perseus status was re-checked on 2026-11-02** against this repository
at commit `5161111` (end of Phases 7-14), by reading the code and running the release build.
The GitKraken columns were not re-researched.

**Legend.** Perseus: ✅ have · 🟡 partial · ❌ missing · ➕ Perseus-only advantage.
GitKraken tier: **Free** = Community plan, **Pro+** = paid. GitKraken's free plan only covers
*local repos and public remotes*; several headline features are tagged "Public Repos Only" on
free, which is the paywall Perseus was built to avoid.

## Where Perseus stands

Since the first version of this document Perseus went from "the daily core loop" to most of
what a Git GUI user expects: stash, tags, hunk and line staging, search, clone and init, tabs,
interactive rebase, a conflict resolver, pull requests for GitHub and GitLab, SSH signing,
submodules, worktrees, a command palette and themes. It is ahead on cost, privacy and weight.

It is **still not at parity**. What is missing is mostly depth and polish rather than whole
areas: **undo/redo**, **syntax highlighting and side-by-side diff**, **image diffs**, **workspaces**
(multi-repo), **Gitflow helpers**, **auto-fetch**, **Bitbucket and Azure DevOps**, **GPG
signing**, **customizable shortcuts**, an **integrated terminal**, AI helpers, and a signed,
auto-updating installer. Section 3 ranks what is left.

Nothing here has been compared side by side with GitKraken; ✅ means the capability exists and
was tested, not that it matches GitKraken's polish.

---

## 1. Feature matrix

### Repository management
| Feature | GitKraken | Perseus |
|---|---|---|
| Open a local repository | Free | ✅ native folder picker |
| Clone / init | Free | ✅ |
| Multiple repos as tabs, per-profile tab sets, tab aliases | Free | 🟡 tabs, restored on start; no per-profile sets or aliases |
| Favorites / recent repos | Free | 🟡 recents on the welcome screen; no favorites |
| Fork a GitHub repo from the app | Free | ❌ |
| Repo maintenance (gc etc.) | Free | ❌ |
| Activity log (every git command, timing, errors) | Free | ✅ in memory, URL passwords redacted |
| Deep links (open a repo/commit from a URL) | Free | ❌ |
| Open in terminal / file manager / IDE | Free | ❌ |

### Commit graph and history
| Feature | GitKraken | Perseus |
|---|---|---|
| Visual commit graph with lanes, merge nodes, ref badges | Free | ✅ canvas, virtualized, streamed |
| Handles very large histories | Slow reports on huge repos (Electron) | ✅ ➕ measured: 500,000 commits ready in 5.5 s, 131 fps scroll (`docs/performance.md`) |
| Ghost branches (show a commit's containing branch) | Free | ❌ |
| Hover highlight of a branch's commits | Free | ❌ (row hover and selection only) |
| Hover tooltip with commit details | Free | ✅ |
| Configurable columns (author, date, sha), resize/reorder, saved per repo | Free | 🟡 resizable columns, saved; not reorderable or toggleable |
| Filter by author / team | Free | 🟡 author filter in search; the graph itself is not filtered |
| Hide and solo branches/tags/remotes | Free | ✅ remembered per repository |
| Search commits by message, sha, author | Free | ✅ message, author, date range, path |
| Keyboard navigation of the graph | Free | ✅ arrows, page, home/end |
| Selected-commit detail (message, ids, parents, files) | Free | ✅ with a signature badge |
| Jump to parent commit | Free | ✅ |

### Diff, blame, files
| Feature | GitKraken | Perseus |
|---|---|---|
| Unified diff view | Free | ✅ virtualized, line numbers, 4 MiB cap, no-exec-diff safety |
| Side-by-side / split diff, word-level highlights | Free | ❌ |
| Syntax highlighting | Free | ❌ |
| File history | Free | ✅ |
| Blame | Free | ✅ |
| Edit and save a file from the diff | Free | ❌ (the conflict resolver can edit by hand) |
| Binary/image diff | Free | ❌ ("Binary files differ" text only) |
| Create / apply patches | Free | ✅ export staged or unstaged changes; apply, optionally staged |
| Cloud Patches (share a patch without a PR) | Pro | ❌ out of scope (needs a cloud) |

### Staging and committing
| Feature | GitKraken | Perseus |
|---|---|---|
| Stage / unstage files | Free | ✅ single or all |
| Stage / unstage / discard **hunks and lines** | Free | ✅ pick hunks or single lines; discard asks first |
| Discard changes | Free | ✅ per file or group, with confirmation |
| Commit with summary + description | Free | ✅ |
| Amend last commit | Free | ✅ message pre-filled |
| Commit templates, conventional-commit helpers | Free | 🟡 the repository's `commit.template` pre-fills the box; no conventional-commit helper |
| Commit author from active profile | Pro (multiple profiles) | ✅ ➕ |
| GPG / SSH commit signing | Free (public) | 🟡 SSH signing (key picker or generated key) with verification badges; GPG ❌ |
| Git hooks run on commit / merge / rebase | Free | ✅ git runs them; "Skip commit hooks" option |
| Co-author handling | Free | ✅ adds `Co-authored-by` trailers |

### Branching, merging, rebasing
| Feature | GitKraken | Perseus |
|---|---|---|
| Create / check out branches (incl. remote → tracking) | Free | ✅ |
| Rename / delete branch | Free | ✅ |
| Merge | Free | ✅ menu + drag-and-drop + confirm |
| Rebase onto a branch/commit | Free | ✅ warns about history rewrite |
| **Interactive rebase** (reorder, reword, squash, drop) | Free for public repos only | ✅ ➕ free on private repos; also fixup |
| Squash commits | Free | ✅ through interactive rebase |
| Cherry-pick one commit | Free | ✅ menu + drag-and-drop |
| Cherry-pick several commits with reorder/squash | Free | ❌ |
| Revert a commit | Free | ✅ |
| Reset (soft/mixed/hard) to a commit | Free | ✅ with confirmation |
| Drag-and-drop branch operations | Free | ✅ ➕ explicit rules, refusal messages, conflict forecast in the dialog |
| Detached HEAD checkout | Free | ✅ |
| Gitflow (start/finish features, releases, hotfixes) | Free for public repos only | ❌ |
| Undo / redo of Git actions | Free | ❌ |
| Conflict-state banner with abort / continue | Free | ✅ merge, rebase, cherry-pick, revert |

### Conflict resolution
| Feature | GitKraken | Perseus |
|---|---|---|
| Built-in merge tool (side-by-side with live output, per-line picks) | Free | 🟡 resolver with ours / theirs / both / hand edit; not per-line picks with a live output pane |
| Open conflicts in external tools (Beyond Compare, P4Merge…) | Free | ❌ |
| Conflict Prevention (warn about likely conflicts early) | Pro | ✅ ➕ a merge or rebase dialog says up front whether it would conflict, free |
| AI conflict resolution | Paid | ❌ |

### Remotes and sync
| Feature | GitKraken | Perseus |
|---|---|---|
| Fetch (all), pull, push | Free | ✅ with live progress |
| Pull variants (ff, ff-only, rebase), default pull type | Free | ✅ fast-forward only / merge / rebase, remembered |
| Push options (force-with-lease, tags, set upstream) | Free | 🟡 set-upstream and force-with-lease; no "push tags" option |
| Manage remotes (add/remove/rename) | Free | ✅ |
| Cancel a running network operation | Free | ✅ kills the whole process tree |
| Auto-fetch in the background | Free | ❌ (status refreshes on window focus and on file changes) |
| Ahead/behind counts | Free | ✅ per branch in the sidebar and on the toolbar |

### Stash, tags, submodules, worktrees, LFS
| Feature | GitKraken | Perseus |
|---|---|---|
| Stash, pop, apply, drop, list in sidebar | Free | ✅ |
| Create (annotated) tags, push/delete tags | Free | 🟡 create and delete; pushing a tag is not a dedicated action |
| Submodules (add, update, list) | Free | 🟡 list with status markers, update all, open as a tab; no "add" |
| Worktrees (create, open, remove, graph indicator) | Free for public repos only | ✅ ➕ free on private repos; no graph indicator |
| Git LFS | Free for public repos only | 🟡 lists patterns, tracks new ones, large-file warning before commit; no locks |

### Identity, authentication, profiles
| Feature | GitKraken | Perseus |
|---|---|---|
| Multiple profiles (name, email, integrations, preferences) | **Pro** | ✅ ➕ free, unlimited |
| Per-profile SSH key, offered exclusively | — | ✅ ➕ `IdentitiesOnly` |
| Per-profile tokens kept in the OS keychain | Account-synced | ✅ ➕ local only, never in files |
| Profile applied without editing `~/.gitconfig` | Optional sync into it | ✅ ➕ command-line overrides only |
| Per-repository profile assignment | not documented | ✅ ➕ URL patterns (`github.com/acme/*`) or pin one repository |
| OAuth sign-in: GitHub, GitLab (incl. self-managed host) | Free | ✅ device flow, tokens auto-refresh, verified live |
| OAuth / integration: Bitbucket, Azure DevOps | Free | ❌ (paste a token) |
| GitHub Enterprise / Bitbucket Data Center | Advanced+ | 🟡 GitHub Enterprise host + client id; others ❌ |
| One-click SSH key generation | Free | ✅ also for signing keys |
| Password / passphrase / host-trust prompts inside the app | Free | ✅ ➕ in-app dialog, answer goes straight to the git process |
| Requires a vendor account to use the app | Yes | ➕ no account, no login |

### Hosting integrations
| Feature | GitKraken | Perseus |
|---|---|---|
| Pull requests: list, filter, create, review, merge | Free (cloud hosts) | 🟡 GitHub and GitLab: list, create, check out, open in browser, merge; no in-app review |
| PR filter syntax, saved views | Free | ❌ |
| Issues from GitHub / GitLab / Jira / Trello | Pro for Jira/Trello | 🟡 GitHub and GitLab issues listed in the sidebar; Jira/Trello ❌ |
| CI status / GitHub Actions workflows | Free | 🟡 CI state shown per pull request; no workflow browser |
| Browser extension | Free | ❌ |

### Collaboration and planning
| Feature | GitKraken | Perseus |
|---|---|---|
| Launchpad (PRs, issues, WIP by status) | Pro | ❌ |
| Workspaces (group repos; multi-repo fetch) | Local free, Cloud Pro | ❌ (tabs only) |
| Team view (what teammates are working on) | Account | ❌ |
| Code Suggest, DORA / Insights, Boards | Paid | ❌ out of scope |

### AI and agents
| Feature | GitKraken | Perseus |
|---|---|---|
| AI commit message / stash message / PR text | Paid (credits) | ❌ deliberately not built |
| AI commit explanation, Commit Composer | Paid | ❌ |
| Coding-agent sessions on worktrees, integrated terminal | Public repos free | ❌ |
| Kepler (multi-repo agent workspace, separate product) | Preview | ❌ out of scope |
| Bring-your-own model key | Pro | ❌ |

### Productivity and interface
| Feature | GitKraken | Perseus |
|---|---|---|
| Command palette (Ctrl+P: checkout, branch, search, stash, patch…) | Free | ✅ `Ctrl+K`: actions, branches, profiles |
| Customizable keyboard shortcuts | Free | ❌ fixed; `?` lists them |
| Themes, UI zoom, preferences screens | Free | 🟡 light / dark / follow system; one preference (large-file limit); no zoom |
| Integrated terminal | Public repos free | ❌ |
| Right-click context menus | Free | ✅ graph, sidebar, files |
| Hover/drag feedback and confirm dialogs | Free | ✅ |
| Installers and auto-update | Free | 🟡 CI builds unsigned installers (NSIS, dmg, AppImage, deb); no signing, no auto-update |

### Security, privacy, footprint
| Aspect | GitKraken | Perseus |
|---|---|---|
| Source available / auditable | Closed | ➕ open |
| Cost for private repos | Pro seat | ➕ free |
| Network calls other than your git remotes | Account, sync, AI, telemetry (per their docs) | ➕ none besides the git host and OAuth provider you use; no telemetry |
| Tokens at rest | Account-synced integrations | ➕ OS keychain only |
| Webview/IPC hardening | Not documented | ➕ isolation pattern, strict CSP, command allowlist; threat model in `docs/threat-model.md` |
| Never runs repo-configured diff/textconv programs | not documented | ➕ enforced and tested |
| Crash reporting | Cloud-based (per their docs) | ➕ local `perseus.log` only, attached by the user if they choose |
| Runtime | Electron | ➕ Tauri + native Rust core |
| Platforms | Windows, macOS, Linux | 🟡 Windows built and exercised (28 end-to-end tests); macOS/Linux compile and bundle in CI only |

---

## 2. What the numbers say

Counting the 112 rows in section 1: Perseus has **63 ✅ or ➕**, **18 🟡** and **31 ❌**
(the first version of this document had 35, 8 and 66 out of 109). Roughly ten of the ❌ rows are
deliberately out of scope (Kepler, Insights, Boards, team services, cloud patches, the
vendor-account features, AI); the rest are real gaps, ranked below. The counts treat every row
equally, which flatters Perseus on the long tail of small rows and understates what remains in
the large ones (diff rendering, workspaces, hosting depth).

## 3. Suggested build order (what is left)

**Tier 1: noticeable in daily use**
1. **Syntax highlighting and side-by-side diff**, with word-level highlights and image diffs.
2. **Undo** for local ref moves (reflog-based) and a way to see what the last operation did.
3. **Auto-fetch** on an interval, and **push tags** (including deleting a tag on the remote).
4. **Cherry-pick several commits**, **submodule add**, **Gitflow helpers**.
5. A graph that scrolls past a few hundred thousand rows (browser scroll-height limit).

**Tier 2: the features people pay GitKraken for**
6. **In-app pull request review**, more hosts (**Bitbucket**, **Azure DevOps**), Jira/Trello issues.
7. **Workspaces**: group repositories, fetch them all.
8. **Per-line conflict picks** with a live output pane; open conflicts in an external merge tool.
9. **GPG signing**.

**Tier 3: polish and reach**
10. Customizable shortcuts, zoom, more preferences, accessibility audit, localisation.
11. Code-signed installers, auto-update, macOS and Linux hands-on verification (owner-only items
    are listed in `docs/releasing.md`).
12. Deep links, "open in terminal / file manager / IDE", repo maintenance, an integrated terminal.
13. Optional AI helpers with a bring-your-own key.

**Probably not worth chasing:** Launchpad, cloud workspaces, team view, Insights, Boards,
Kepler/agent orchestration. They depend on a vendor account and cloud backend; Perseus's
local-first, no-account design is a feature.

## 4. Caveats

- GitKraken facts come from its public docs and pricing page and were **not refreshed** for this
  update. The pricing page's per-plan check marks did not extract cleanly, so *which tier* some
  features need is partly inferred; the "Public Repos Only" tags on free are from the page text.
- GitKraken was never used hands-on. Its 12.x line also moved heavily toward AI-agent workflows,
  so some rows (agent sessions, Kepler) are about a product direction Perseus does not need to
  follow.
- Perseus statuses were taken from the code and the roadmap, plus the test suites (Rust,
  Vitest, and 28 end-to-end tests against the release build). Pull requests, issues and CI
  state for GitHub and GitLab are covered by unit tests only; only OAuth sign-in was verified
  against the real services. macOS and Linux were never run.
- Performance figures are Perseus's own measurements on synthetic repositories
  (`docs/performance.md`); there is no like-for-like benchmark against GitKraken.

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
