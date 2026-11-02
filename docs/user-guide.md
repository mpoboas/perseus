# Perseus user guide

## First steps

1. **Open a repository** (`Ctrl+O`), **clone** one, or **create** a new one from the welcome screen
   or the command palette. Repositories you opened before are listed on the welcome screen and
   stay open as tabs.
2. The **graph** in the middle shows the history (branch and tag labels in their own column on the left,
   an avatar on every commit, small rings for merges), the **sidebar** on the left lists branches, tags,
   remotes, stashes and (when the repository has them) pull requests, submodules, worktrees and LFS
   patterns, and the **right panel** shows the selected commit or your working changes.
3. Press **`Ctrl+K`** at any time for the command palette: every action, every branch, every profile.

## Committing

- Open the **Changes** tab. Tick a file to stage it, untick to unstage. Click a file to see its diff.
- In a diff, tick **single hunks** or **single lines** to stage only part of a file.
- Write a summary (and optionally a description), then **Commit** or press `Ctrl+Enter`.
- **Amend the last commit** pre-fills its message. **Add co-authors** appends `Co-authored-by`
  trailers. **Skip commit hooks** runs `git commit --no-verify`.
- If a staged file is larger than the limit set in **Preferences** (50 MB by default) a warning
  appears before you commit, with a shortcut to track that type of file with Git LFS.
- **Stash changes…** saves your work aside; stashes appear in the sidebar (right-click to apply, pop
  or drop).

## Branches, merging and history editing

- **Undo** and **Redo** (toolbar, palette, `Ctrl+Z` / `Ctrl+Shift+Z`) put your local branches back as they were
  before the last action: a commit (its changes stay staged), merge, rebase, checkout, branch delete and so
  on. Nothing that was pushed is touched, and an undo that would overwrite uncommitted work is refused.
  The history lasts until you close Perseus.
- In the graph a **laptop** on a branch label means the branch exists on this computer and a **cloud** means a
  remote has it too; hover a label for the full names. Hovering a commit with no label shows, faded, the
  branch it belongs to.
- The toolbar has **Fetch, Pull, Push, Branch, Stash and Pop** (Pop applies the newest stash and removes it).
- Double-click a branch to check it out; right-click for more (merge, rebase, rename, delete,
  hide from graph, show alone, open in a new worktree, create a pull request).
- **Drag** a branch or commit onto another to merge, rebase or cherry-pick. A dialog explains the
  result first, including whether it would conflict. Operations that rewrite history say so and
  ask for confirmation.
- **Conflicts**: the Changes tab shows a banner while a merge, rebase, cherry-pick or revert is
  paused. **Resolve…** opens the conflict editor (ours, theirs, both, or edit by hand); then
  **Continue** or **Abort**.
- **Interactive rebase**: right-click a commit and choose the interactive rebase action to reorder,
  squash, fix up, drop or reword the commits after it.
- **Reset**, **revert**, **tags** and **discard changes** are on the context menus. Discarding
  cannot be undone and always asks first.

## Finding things

- `Ctrl+F` searches commits by message, author or content.
- Right-click a file in a commit or in the Changes tab for its **history** and **blame**.
- Hidden or "solo" branches (sidebar context menu) are remembered per repository.

## Remotes, sign-in and profiles

- **Fetch**, **Pull** (merge or rebase) and **Push** are in the toolbar; force push uses
  `--force-with-lease`. Long operations can be cancelled.
- **Profiles** (toolbar → profile menu → Manage profiles) hold a name and e-mail, an optional SSH
  key, an optional signing key, and a sign-in. Switch with the menu or the palette; Perseus never
  edits your global Git configuration.
  - **Automatic switching**: add a pattern such as `github.com/acme/*`; repositories whose remote
    matches use that profile. "Always use this profile for this repository" pins one.
  - **Sign in** to GitHub or GitLab from the profile (device flow / browser), or paste a personal
    access token. Tokens are stored in the operating system's keychain.
  - **Signing**: choose SSH signing and either pick a key or let Perseus generate one. Signed
    commits show a badge in the commit details.
- If Git or SSH needs a password, a passphrase, or a "trust this host?" answer, Perseus shows the
  question in a dialog and passes your answer directly to the git process. Cancel to make the
  operation fail cleanly instead of waiting.

## Pull requests and issues

For repositories whose remote is on GitHub or GitLab and whose profile is signed in, the sidebar lists open
pull (or merge) requests with their CI state, and open issues. Click a pull request for a menu to check it out,
open it in the browser or merge it; use the branch menu to create one.

## Submodules, worktrees and LFS

- **Submodules** appear in the sidebar with a marker when they are not downloaded or sit on a
  different commit than the project records. Double-click one to open it as its own tab; *Update all
  submodules* downloads and checks them out.
- **Worktrees**: right-click a branch → *Check out in a new worktree…*, pick a parent folder, and
  Perseus creates `<folder>/<branch>`. Linked worktrees are listed in the sidebar; double-click to
  open, or remove one with the bin icon.
- **Git LFS**: the sidebar lists the patterns the repository tracks; if `git lfs` is installed you can
  track a new pattern.

## Preferences and the activity log

The gear in the toolbar (or *Preferences and activity log…* in the palette) holds how the graph shows
dates (`07/10/2026 @ 14:37` or `26d ago`), the large-file threshold and the **activity log**: every git command Perseus ran, with timing and the first line of
any error. Passwords embedded in URLs are replaced by `***`. The log lives in memory only.

Profile pictures: for repositories on github.com, the picture of the GitHub account linked to each commit is
shown (GitHub's own commit record answers this, so it works even when the author's address is private), plus
your own signed-in account. Branches that exist on the remote show the remote owner's picture. Gravatar, which
covers people GitHub does not know, is a separate opt-in because it sends a hash of each address to a third
party. A preference turns all pictures off.

Themes (light, dark, follow system) are in the toolbar and the palette.

## Keyboard shortcuts

Press `?` for the full list. The most useful: `Ctrl+K` palette, `Ctrl+O` open, `Ctrl+F` search,
`Ctrl+B` sidebar, `F5` refresh, `Ctrl+Enter` commit, `Esc` close the diff.

## Where your data lives

- Profiles and recent repositories: the application data folder
  (`%APPDATA%\dev.perseus.app` on Windows). Set `PERSEUS_DATA_DIR` to use another folder.
- Tokens: the operating system keychain, never a file.
- Crash log: if Perseus ever panics, a line describing it is appended to `perseus.log` in that same
  folder (rotated at 256 KB). It stays on your computer; attach it to a bug report if you want to.
- Preferences such as pane sizes and theme: the web view's local storage.
- Perseus makes no network requests of its own except to the Git hosts and OAuth providers you use.
