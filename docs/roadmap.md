# Perseus roadmap: everything still to build

Phases 0-5 are done (scaffold, graph streaming, graph and lanes, diffs and write operations,
profiles and OAuth, drag-and-drop and hardening). This document plans **everything else**, in
building phases, derived from three sources: the original plan's unfinished items, the
[GitKraken gap analysis](gitkraken-comparison.md), and the known limitations found while
testing. Sizes are rough focused-work estimates for one developer: **S** 1-2 days,
**M** 3-5 days, **L** 1-2 weeks, **XL** 2+ weeks.

## Status (updated at the end of the overnight build)

Phases 0-14 are built and tested; Phase 15 is built as far as it can be without the owner.
Decisions taken by default while the owner was away are listed so they can be revisited.

| Phase | State | Notes |
|---|---|---|
| 6 UI/UX | Done | See "Delivered" under Phase 6 |
| 7 Foundations | Done | `PERSEUS_DATA_DIR`, watcher, commit-graph auto-write, perf notes in `docs/performance.md`, Playwright E2E over WebView2 (`pnpm e2e`), CI builds an unsigned NSIS installer and runs the E2E |
| 8 Everyday Git | Done except undo | Stash, tags, branch delete/rename, reset, revert, discard, remotes, pull modes, force-with-lease, cancel |
| 9 Staging and diffs | Done except highlighting | Hunk and line staging, file history, blame, patch export/apply. **Not done:** syntax highlighting, side-by-side diff |
| 10 Navigation | Done except deep links | Tabs, search, clone/init, hide/solo, recents. **Not done:** deep links (`perseus://`), the scroll-height fix for graphs of several hundred thousand rows |
| 11 Conflicts and history editing | Done except multi-pick | Conflict resolver, interactive rebase, conflict preview. **Not done:** cherry-picking several commits at once |
| 12 Hosting | GitHub and GitLab | Pull/merge requests, issues, CI state. **Not done:** Bitbucket, Azure DevOps, and live testing against real accounts (covered by unit tests only; OAuth sign-in for GitHub and GitLab was verified live earlier) |
| 13 Identity and signing | Done except GPG | Askpass prompts for git and ssh, SSH signing + verification badges, key generation, profile rules and pinning, skip hooks |
| 14 Workflow extras | Partly | Submodules, worktrees, Git LFS (detect/track), large-file warning, preferences, activity log. **Deferred on purpose:** integrated terminal, AI helpers, workspaces, customizable shortcuts, Gitflow helpers, zoom, auto-fetch interval |
| 15 Release engineering | Partly | README, user guide, threat model, local error log, per-OS bundle matrix in CI. **Owner-only (not done):** code-signing certificates, notarization, updater signing key and update hosting, first public release, macOS/Linux hands-on verification, formal accessibility audit, i18n |

Defaults chosen without the owner (revisable): **MIT license**; **Windows first**; **no telemetry**;
no integrated terminal and no AI helpers in scope; signing, notarization, updater keys and
publication are left for the owner. Nothing was pushed or published: the `birth` branch is local.

## Milestones

| Milestone | After | What it means |
|---|---|---|
| **Alpha** | Phase 9 | A Git GUI you could use all day on Windows: unsigned installer, stash, tags, hunk staging, good diffs |
| **Beta** | Phase 12 | Reasons to switch from GitKraken: conflict editor, interactive rebase, pull requests |
| **1.0** | Phase 15 | Signed installers for three platforms, auto-update, security review, docs |
| **After 1.0** | Phase 14's optional items | Terminal, AI helpers, Gitflow |

```
 6 UI & UX ── 7 Foundations ─┬─ 8 Everyday Git ── 9 Staging & diffs ──▶ ALPHA
                              │
                              └─ 10 Navigation & multi-repo ─ 11 Conflicts & history editing ─ 12 Hosting ──▶ BETA
                                          13 Identity, signing, credential UX (can start after 8)
                                          14 Workflow extras ────────────────▶ 15 Release engineering ──▶ 1.0
```

Phase 6 comes first because it is where progress is *visible*, and every later feature then lands
in a polished shell instead of being retrofitted. It pulls forward a few small items that
later phases list (themes, a basic command palette, a recents list, sidebar folders and filter,
column resizing, line numbers in diffs); those phases keep the remaining depth.

## Standing rules (apply to every phase)

Definition of done for any feature. These come from the conventions the project already has.

1. **Backend**: git runs only through `src-tauri/src/git/cli.rs`; every webview-supplied string
   is validated in `git/validate.rs`; no shell, no secret ever sent to the webview.
2. **New command** = three edits: `COMMANDS` in `build.rs`, a permission in
   `capabilities/default.json`, an entry in `isolation/index.js` (a test enforces this).
3. **Tests**: Rust tests that run real `git` in temp repos (including hostile inputs);
   Vitest for pure frontend logic; keychain/network tests `#[ignore]`d.
4. **Verified in the real app**, not just unit tests, including a **release build** when UI or
   CSP is touched (dev CSP is looser than production).
5. **Docs** updated; `cargo fmt`, `clippy -D warnings`, `cargo deny`, `pnpm audit` clean.
6. **Confirm step** for anything destructive or history-rewriting; refusals explain why.
7. **Commits**: subject line only, no co-author trailer.

---

## Phase 6: UI and UX overhaul  `XL`   (built; see "Delivered" below)

**Goal.** Turn a working prototype into an application that looks and feels finished. No new Git
capabilities: every existing capability gets a clear, fast, good-looking, discoverable interface.

**Design system**
- **Tokens** for color, type, spacing, radius, elevation and motion; a carefully tuned **dark** and
  **light** theme plus "follow system", chosen in the toolbar and the palette, remembered between runs.
- **Icon set** (one consistent family) and a small **component library**: buttons, icon buttons,
  inputs, segmented controls, tabs, chips, avatars, tooltips, dialogs, menus, toasts, spinners,
  skeletons, splitters, keyboard-key hints, empty states.
- Visible focus rings, reduced-motion support, sensible contrast in both themes.

**Application shell**
- **Welcome screen** with recent repositories (new, validated recents store in the backend), a
  primary "Open repository" action, and shortcut hints.
- **Top bar**: repository and branch switcher, fetch / pull / push with ahead/behind and progress,
  profile menu showing the active identity, theme toggle.
- **Status bar** (repo path, operation progress, in-progress merge/rebase indicator).
- **Resizable, collapsible panes** whose sizes persist.
- **Toasts** replace the single status line: success, error (with copy-details), info.

**History and graph**
- Larger rows, **column header with resizable columns**, author **avatars** (initials, no network),
  typed **ref chips** (branch / remote / tag / HEAD), hover and selection states, polished lanes
  and nodes that follow the theme, loading skeletons and empty states.
- **WIP row** at the top of the graph (working-tree summary) that opens the Changes panel.

**Panels**
- **Sidebar**: collapsible sections with counts, a filter box, branch **folders**, current-branch
  emphasis, **ahead/behind** per branch (new backend data), context menus.
- **Commit detail**: header with avatar, copyable id, parent chips, styled message, file list with
  status icons and **+/- line counts** (new backend data), tree/flat toggle.
- **Changes panel**: checkbox staging, per-file counts, collapsible groups, summary + description
  commit box with guidance, clear disabled states.
- **Diff viewer**: line-number gutters, file header with counts, refined colors and hunk headers.

**Everywhere**
- **Command palette** (Ctrl+K / Ctrl+P): open repo, fetch/pull/push, check out branches, switch
  profile, toggle theme, go to a commit; a **shortcuts** cheat-sheet.
- Restyled **Profiles**, sign-in and confirm dialogs.

**Exit.** Every screen reviewed in both themes in the running app and in a **release build**;
keyboard-only use of the main flows; no layout shift or flicker during common operations;
Vitest coverage for the new pure logic; no regressions in the existing test suites.
**Out of scope here.** Syntax highlighting and side-by-side diff (Phase 9), tabs for several
repositories (Phase 10), the full preferences screen (Phase 14).

**Delivered.** Everything above except the items under "Not yet done". Backend: recents store,
per-file line counts, per-branch upstream with ahead/behind/gone. Frontend: tokens and three theme
modes, `src/ui` primitives, `src/lib` helpers (Vitest), welcome screen, toolbar, status bar,
persisted resizable panes and graph columns, WIP row, avatars, ref chips, sidebar tree, commit
detail with tree/flat files, checkbox staging, diff gutters, command palette, toasts, restyled
dialogs. Checked in the running dev app (dark and light) and in a release build, where the only
console messages are the two known isolation-iframe CSP entries (see `docs/security.md`).

**Not yet done.**
- The status bar does not show an in-progress merge/rebase; the Changes tab banner does.
- Keyboard-only use of every flow and contrast ratios were not audited formally; focus rings,
  roles and labels are in place, but a real accessibility pass belongs with Phase 15.
- Colors for the "gone" upstream and conflict states were judged by eye only.

---

## Phase 7: Foundations, measurement and an early build  `L`

**Goal.** Replace "I believe it's fast" with numbers, make UI testing automatic, remove the
"reload everything after every action" shortcut, and prove we can ship a build.

- **Performance harness**: generate repos of 10k / 50k / 500k commits (fast-import), measure
  scroll frame time, time-to-first-rows, memory. Close the unmeasured exit criteria from
  Phases 1-2 (60 FPS on 50k rows).
- **E2E harness**: Playwright over WebView2's debug port (the technique used to inspect the
  release build) for the production exe: open repo, graph renders, diff opens, commit, drag-and-drop.
  Runs in CI on Windows.
- **Graph snapshot tests** on fixture repos (linear, merges, octopus, criss-cross), as promised in Phase 2.
- **File-system watcher** (`notify`, debounced; worktree + `.git/HEAD|refs|index`) replacing
  refresh-on-focus.
- **Incremental refresh**: after commit, checkout, merge etc. update refs, status and the top of the
  graph rather than restarting the whole stream; keep selection and scroll position.
- **Early packaging**: an **unsigned Windows installer** built in CI, with the credential helper
  bundled (`externalBin`). Surfaces packaging surprises long before 1.0.
- **Housekeeping**: choose the project license (see Decisions), publish the repo structure
  (merge `birth` into `main` through a PR), CONTRIBUTING, issue templates.

**Exit.** Documented performance numbers with budgets; E2E green in CI; ops no longer flicker
the graph; an installer that opens a repo on a clean Windows VM.
**Risks.** Playwright + WebView2 setup; installer + helper bundling paths.

## Phase 8: Everyday Git completeness  `L`

**Goal.** No common daily action sends the user to a terminal.

- **Stash**: create (message, include untracked), list in the sidebar, apply, pop, drop, view diff.
- **Tags**: create lightweight and annotated, delete, push/delete on remote; tag chips already render.
- **Branches**: delete (local and remote) with "unmerged commits" warning, rename, set upstream.
- **Reset** (soft/mixed/hard, hard behind a confirm that shows lost changes), **revert** a commit
  (incl. merge commits with mainline choice).
- **Discard changes** for files (hunks arrive in Phase 9).
- **Remotes**: list, add, rename, remove, change URL. **Push options**: force-with-lease (confirm),
  push tags, push to another remote. **Pull variants**: ff-only / merge / rebase, with a default setting.
- **Cancel** for fetch/pull/push (kill the child, clean up), with a visible Cancel button.
- **Undo / redo** of local ref moves, built on a recorded stack of `(ref, old, new)` plus the reflog;
  covers commit, amend, checkout, merge, rebase, reset, branch ops; never claims to undo a push.

**Exit.** Each action has real-git tests and a UI path (menu and, where natural, drag); undo restores
exact ref state in tests; cancel leaves no lock files.
**Depends on.** Phase 7 incremental refresh. **Risks.** Undo semantics with a dirty working tree
(use `reset --keep`, refuse when unsafe).

## Phase 9: Staging, diffs and file history  `L`   → **Alpha**

**Goal.** Match the expected quality of the working-tree and diff experience.

- **Hunk and line staging / unstaging / discarding**: parse the unified diff in Rust, let the
  user select hunks or lines in the diff view, build a patch and apply with
  `git apply --cached [--recount]` (and `-R` for discard).
- **Syntax highlighting** (lazy-loaded, off the main thread; pick the engine in Phase 9 design:
  CodeMirror 6 vs a lighter highlighter), **line numbers**, **side-by-side** mode, **word-level**
  highlights, expandable context, whole-file view.
- **Large and special files**: image diff, binary summary, the 4 MiB cap becomes "load more";
  decode patches in a Worker (original plan item).
- **File history and blame** (`git log --follow`, `git blame --porcelain`), jump from a blame line to its commit.
- **Patches**: create from working changes / a commit, apply a patch file.
- **Commit box**: separate summary and description, character guide, amend pre-filled with the
  previous message, commit templates, co-author trailers.
- **Edit and save a file** from the diff view (small, optional).

**Exit.** Line-staging round-trips on files with CRLF, renames and no-newline-at-EOF; diff of a
5 MB file stays responsive; E2E covers stage-a-line-then-commit.
**Risks.** Patch construction edge cases (the biggest correctness risk in this phase; property-test it).

## Phase 10: Navigation, search and multi-repository  `L`

**Goal.** Move around big histories and many repos comfortably.

- **Commit search** by message, sha, author, date range and touched path (streamed results, jump to commit).
- **Graph filtering**: by author; **hide / solo** refs (persisted per repo); **ghost branches** and
  hover-highlight of a branch's commits; configurable, resizable, reorderable **columns** (author, date, sha).
- **Sidebar**: collapse `feature/*` folders, filter box, ahead/behind per branch, remote groups.
- **Repo tabs** with per-tab state, alias, favorites and a recents list.
- **Clone** (progress, uses the active profile's credentials) and **init**.
- **Open in** terminal / file manager / editor; **deep links** (`perseus-app://open?path=…`, validated).
- **Graph scale work** driven by Phase 7 numbers: commit-graph file generation numbers,
  windowed/lazy lane computation if 500k-row repos miss the budget.

**Exit.** Search over 500k commits returns first hits quickly; tabs survive restart; clone works with
a private repo through a profile.

## Phase 11: Conflicts and history editing  `XL`

**Goal.** The features people pay GitKraken for.

- **Merge conflict editor**: base / ours / theirs and a live output, per-hunk and per-line picks,
  "take all", undo, mark resolved. Reads index stages (`git show :1/:2/:3`), handles
  delete-vs-modify, rename, binary and submodule conflicts, offers external merge tools.
- **Interactive rebase**: todo list with reorder, pick, reword, edit, squash, **fixup**, drop,
  autosquash. Executes via `GIT_SEQUENCE_EDITOR` that installs our prepared todo (and `exec`
  lines for rewording), with stop handling (edit/conflict) feeding the existing continue/abort banner.
  GitKraken lacks fixup/edit, so this can exceed it.
- **Conflict prediction** before merge, rebase and cherry-pick using `git merge-tree --write-tree`
  (git ≥ 2.38; degrade gracefully): show "N files would conflict" in the confirm dialog.
- **Multi-commit cherry-pick** with reorder and squash, revert ranges, **squash selected commits** shortcut.
- Conflict state badges on the graph while an operation is paused.

**Exit.** Resolve a three-file conflict (including delete/modify) entirely in-app in E2E;
interactive rebase of 20 commits with reword + squash + drop yields the expected tree and messages.
**Risks.** Rebase state machine edge cases (external rebases in progress, hooks); the largest item in the plan.

## Phase 12: Hosting integrations  `XL`   → **Beta**

**Goal.** Pull requests and issues without leaving the app. The OAuth tokens already exist.

- **Provider layer in Rust** (tokens never reach the webview): GitHub and GitLab first, then
  Bitbucket Cloud (API token) and Azure DevOps (PAT), plus self-hosted GitHub Enterprise / GitLab.
  Caching, ETags, rate-limit handling, offline behavior.
- **Pull / merge requests**: list with filters, detail (status, reviewers, checks), **create from a
  branch**, check out a PR branch, merge (strategy choice), open in browser. Review comments:
  read first, write later.
- **Issues** list and linking (branch name / commit message conventions).
- **CI status** on commits and PRs (GitHub checks, GitLab pipelines), "run workflow" later.
- Sidebar sections: Pull Requests, Issues; graph badges for PR heads.
- OAuth/token flows for Bitbucket and Azure DevOps where the provider allows them.

**Exit.** Create a PR from a branch on GitHub and GitLab test accounts through the UI; rate-limit tests with a fake server.
**Depends on.** Phase 10 sidebar work. **Risks.** API surface and per-provider quirks; keep the
provider trait small and test with recorded fixtures.

## Phase 13: Identity, signing and credential experience  `L`   (can start after Phase 8)

**Goal.** Finish the part of the product that is meant to be better than GitKraken's.

- **Per-repository profile assignment**: auto-activate on open by repo path or remote URL pattern
  (like git's conditional includes), shown in the toolbar.
- **Credential prompts instead of failures**: an in-app askpass dialog for **SSH key passphrases**
  and **HTTPS username/password**, and a **host-key trust prompt** (today ssh runs in `BatchMode`
  and the first connection to a new host fails by design).
- **Commit signing**: SSH signing (`gpg.format=ssh`, allowed-signers management) and GPG (binary
  detection, pinentry integration), per-profile signing keys, **signature verification badges** in graph and detail.
- **SSH key generation**, copy public key, add it to GitHub/GitLab through the API.
- **Hooks UX**: show hook output and failures, "skip hooks" toggle with a warning.
- **SSH agent emulator**: *evaluate* after askpass lands; build only if passphrase-protected keys
  still can't be used cleanly (it was a stretch goal in the original plan).
- **Threat-model document** and a validator fuzzing pass.

**Exit.** Push over SSH with a passphrase-protected key and a new host succeeds with in-app prompts only;
signed commits verify; profile follows the repo.
**Risks.** Platform differences (pinentry, ssh-agent on Windows); keep prompts out of the
webview's reach of secrets (answers go straight to the child process).

## Phase 14: Workflow extras and power features  `L-XL`

**Goal.** Cover the long tail; sort by user demand.

- **Submodules** (list, init, update, status markers, open as repo), **worktrees** (create, open,
  remove, graph indicator), **Git LFS** (detect, track, status, large-file warnings), **Gitflow** helpers
  (built: set up, start and finish features, releases and hotfixes; no support branches).
- **Command palette** (Ctrl+P), **customizable shortcuts**, **preferences** (themes light/dark/custom,
  zoom, graph options, default pull type, auto-fetch interval), **activity log** viewer.
- **Workspaces** (local): group repos, multi-repo fetch and status.
- **Integrated terminal** (xterm.js + a PTY): treated as high risk; only when explicitly opened by
  the user, with its own IPC commands added to the isolation allowlist and reviewed.
- **Optional AI helpers** (commit message, explain commit, PR text, conflict suggestions) with
  **bring-your-own key** (keychain) and a **local-model option**; opt-in, with a clear "this sends
  your diff to X" notice. Decision-gated (see below).

**Exit.** Each item behind its own test; terminal and AI are feature-flagged until reviewed.

## Phase 15: Release engineering and 1.0  `L`   → **1.0**

**Goal.** Something strangers can install, trust and update.

- **Installers**: Windows (MSI/NSIS), macOS (DMG), Linux (AppImage + deb), bundling the credential helper.
- **Code signing and notarization**: Windows Authenticode/Trusted Signing, Apple Developer ID + notarization.
- **Auto-update** (Tauri updater with signed update manifests, hosted on GitHub Releases);
  its permissions and CSP changes reviewed; update channel setting.
- **Cross-platform verification** of everything: keychain backends (Secret Service availability and a
  clear fallback when absent), file locks, path handling, WebKit/GTK rendering of the canvas, fonts, HiDPI.
- **Accessibility pass**: keyboard-only use, screen-reader names, an accessible list alternative to the
  canvas graph, contrast, reduced motion.
- **Internationalization** scaffolding (strings extracted; Portuguese as a first extra locale if wanted).
- **Security review**: external or structured self-review against the threat model, SBOM, reproducible-build
  notes, `cargo deny` / `pnpm audit` gates, advisory-ignore audit.
- **Docs**: user guide, README with screenshots, comparison page, release notes process.
- **Crash and error logs**: local files, opt-in sharing only (no telemetry by default).

**Exit.** Clean-machine install, update and uninstall on all three platforms; checklist signed off.

---

## Decisions needed from the owner

| # | Decision | Needed by | Notes |
|---|---|---|---|
| 1 | **Project license** (MIT / Apache-2.0 / GPL / AGPL …) | Phase 7 | Currently undecided; affects contributors and the license gate in `deny.toml` |
| 2 | **Name, app identifier and branding** | Phase 15 (ideally earlier) | Bundle id `dev.perseus.app` is a placeholder; check trademark/domain |
| 3 | **Platforms at launch**: Windows only first, or all three | Phase 7 | Drives CI cost and verification work |
| 4 | **AI features**: in scope? BYO-key only? local models? | Phase 14 | Privacy stance is a selling point; AI changes the story |
| 5 | **Which hosts matter**: Bitbucket / Azure DevOps priority | Phase 12 | Bitbucket Cloud has no good OAuth path (API token only) |
| 6 | **Code-signing budget** (Windows certificate / Trusted Signing, Apple Developer account) | Phase 15 | Unsigned builds trigger SmartScreen/Gatekeeper warnings |
| 7 | **Telemetry stance**: none, or opt-in crash reports | Phase 15 | Default in this plan: none |
| 8 | **Release/hosting model**: GitHub Releases + updater, or elsewhere | Phase 15 | |
| 9 | **Terminal in the app**: yes / no | Phase 14 | Largest attack-surface addition in the plan |
| 10 | **Repository publication**: where, when, and public vs private first | Phase 7 | The `birth` branch is local only today |

## Known limitations being tracked

- SSH keys must be unprotected or already in an agent; unknown hosts fail until connected once (Phase 13).
- Credential helper must sit next to the app (Phase 7 early packaging, Phase 15).
- The graph reloads fully after each operation (Phase 7).
- 60 FPS scrolling on 50k rows and memory use are unmeasured (Phase 7).
- Only Windows has been exercised; macOS and Linux build in CI but are untested (Phases 7 and 15).
- A single global active profile (Phase 13).
- Bitbucket and Azure DevOps have no sign-in flow (Phase 12).
