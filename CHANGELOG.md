# Changelog

Commit subjects are the detailed changelog (`git log --format=%s`); this file is the summary for each release.

## 0.1.0: first release

The first public version of Perseus: a fast, free and open-source visual Git client built with Tauri and Rust.

**Git, every day**
- A commit graph drawn on a canvas and streamed from Rust, smooth on repositories with 100,000+ commits.
- Stage files, hunks and single lines; commit, amend, stash, tags, branches, merge, rebase, cherry-pick, revert,
  reset, fetch / pull / push (with force-with-lease), and undo / redo of branch moves, tags, stashes and file edits.
- Drag a branch or commit onto another to merge, rebase or cherry-pick, with a preview of conflicts first.
- Conflict resolver, interactive rebase editor, file history, blame, search, patch export and apply.
- Several repositories as tabs with favorites and names of your own, clone and init from the app, submodules,
  linked worktrees, Git LFS, Gitflow, auto-fetch and repository maintenance.

**Accounts and hosts**
- Identity profiles (name, e-mail, SSH key, signing key, sign-in) picked by remote, without touching your Git
  configuration; SSH commit signing and signature badges.
- GitHub and GitLab sign-in (device flow / PKCE) or a token; pull and merge requests, issues, CI state, forking,
  and creating and publishing repositories. Secrets live in the operating system's keychain.
- No account required, no telemetry; nothing is sent anywhere except to the Git hosts you talk to.

**Make it yours**
- Light, dark and system themes in two palettes (Slate and Indigo), zoom from 50% to 200%.
- Every keyboard shortcut can be changed (*Settings → Keyboard shortcuts*), with ⌘ on macOS and Ctrl elsewhere.
- Interface in English or European Portuguese (the welcome screen, toolbar, status bar and the shortcut and
  appearance settings are translated; the rest follows).

**Accessibility**
- Contrast of all four themes is tested against WCAG AA; the commit graph is also offered to screen readers as a
  list; the menu key opens the selected commit's context menu; high-contrast modes are handled. A pass with real
  screen readers has not been done yet (`docs/accessibility.md`).

**Platforms**
- Windows is the best tested platform. macOS now builds as an app and a disk image, and the app has been launched; Linux builds in
  CI but has not been run by hand.
- Installers are not code-signed or notarized yet, so Windows SmartScreen and macOS Gatekeeper will warn on first
  launch (`docs/releasing.md`).

**Known gaps**: in-app pull request review, Bitbucket and Azure DevOps, workspaces, per-line conflict picks, GPG
signing and an integrated terminal. See `docs/roadmap.md`.
