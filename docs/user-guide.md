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

## Your repositories

- **Clone** (welcome screen, toolbar repository picker, or the palette) has a list of sources down the left,
  like GitKraken's: *Clone with URL*, and one entry per host you can sign in to (GitHub.com, GitLab.com, and
  other GitHub or GitLab hosts your profile has a login for). Pick a host to see the repositories of your
  account, grouped by owner or organization (a lock marks private ones, most recently active first, up to
  500), search them, choose one and clone it into the folder under *Where to clone to* (*Browse* changes it;
  it starts as the folder you used last). Tick *Fork it to my account first* and the button becomes *Fork and
  clone*: Perseus forks the repository on the host, clones your copy as `origin`, and keeps the original as
  `upstream`. A repository that is already yours cannot be forked. This needs the profile to be signed in to
  that host.
- **Create** (welcome screen or palette → *Create a new repository…*) uses the same layout: *Local only* makes a
  folder with a new repository in it (optionally with a README as the first commit); *GitHub.com* or *GitLab.com*
  also creates it on the host, under your account or one of your organizations or groups, private or public, and
  pushes the first commit, so it is on the host straight away. The local repository is made first: if the host
  refuses (the name is taken, no permission), you keep the local one and are told why, and if the push fails you
  can push again from the toolbar. Template files (`.gitignore`, a license) are not offered yet.
- **Favorites**: the star next to a repository (welcome screen, the repository picker in the toolbar, or a
  tab's right-click menu) pins it under *Favorites*, listed first and by name. Favorites never fall off the
  list of recent repositories; the other recents keep the last 20.
- **Names**: *Rename* (the pencil on the welcome screen, a tab's menu, double-clicking a tab, or the palette)
  gives a repository a name of your own, shown in tabs, lists and the toolbar. The folder keeps its name,
  which stays visible next to it; clearing the field goes back to the folder's name.
- **Tabs per profile**: each profile keeps its own set of open tabs. When *you* switch profile (toolbar menu or
  palette) Perseus keeps the tabs of the profile you leave and brings back the other's, with the repository
  that was in front. A profile with no tabs yet starts with the repository you are looking at. A profile
  that a repository's rule or pin picks on opening does not move your tabs.
- **Links**: *Copy a Perseus link to this repository* (palette) and *Copy a Perseus link to this commit* (a
  commit's menu) make `perseus-app://open?path=…&commit=…` addresses. Opening one, from a chat or a web page,
  opens the repository in Perseus and selects the commit. A link only ever opens a folder and shows a
  commit. A repository Perseus has opened before opens straight away; a folder it has not seen asks you
  first, in a window of its own. Installed copies register the `perseus-app://` address themselves; for a
  copy you only unpacked, use *Settings → General → Links → Register for this user*. Launching Perseus a
  second time (with or without a link) brings the running window forward instead of opening another.
- **Maintenance** (palette → *Repository maintenance…*): shows how many loose and packed objects the
  repository has and whether Git would soon clean it up itself, and runs *Optimize* (`git gc`: it only removes
  unreachable objects older than two weeks), *Rebuild the commit graph file*, *Check integrity* (`git fsck`,
  listing what it finds), *Forget stale remote branches* and a slower *Deep optimize*. Any of them can be
  stopped. There is deliberately no "delete everything unreachable now".

## Committing

- Open the **Changes** tab. Tick a file to stage it, untick to unstage. Click a file to see its diff.
- In a diff, tick **single hunks** or **single lines** to stage only part of a file.
- Diffs are **coloured by language** (about twenty-five languages and config formats), and the **words
  that changed** inside a removed and the added line that replaces it are marked. The two icons in the
  diff's header switch between **one column** and **side by side**; Settings → UI Customization sets the
  default and can turn the colours and word marks off.
- **Pictures** (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG) are shown instead of a text diff: the before and
  the after side by side, or a **Swipe** slider to wipe one over the other, with their sizes. Tiny images are
  enlarged so they can be seen. An SVG can be read as text too.
- Write a summary (and optionally a description), then **Commit** or press `Ctrl+Enter`.
- **Amend the last commit** pre-fills its message. **Add co-authors** appends `Co-authored-by`
  trailers. **Skip commit hooks** runs `git commit --no-verify`.
- If a staged file is larger than the limit set in **Preferences** (50 MB by default) a warning
  appears before you commit, with a shortcut to track that type of file with Git LFS.
- **Stash changes…** saves your work aside; stashes appear in the sidebar (right-click to apply, pop
  or drop).

## Branches, merging and history editing

- **Undo** and **Redo** (toolbar, palette, `Ctrl+Z` / `Ctrl+Shift+Z`) put things back as they were before the
  last action: a commit (its changes stay staged), merge, rebase, checkout, branch delete, **tag** created or
  deleted, **stash** pushed, popped or dropped, and **staging, unstaging and discarding** changes to tracked
  files. Nothing that was pushed is touched. An undo that would overwrite newer work is refused with a message
  and changes nothing: a discard is only brought back while the files are still as the discard left them.
  Untracked files cannot be brought back (git never stored them), except those a stash pop restored, which
  go away again if they are still as they were stashed. The history lasts until you close Perseus.
- In the graph a **laptop** on a branch label means the branch exists on this computer and a **cloud** means a
  remote has it too; hover a label for the full names. Hovering a commit with no label shows, faded, the
  branch it belongs to.
- The toolbar has, on the left, the **repository** and **branch** pickers. Click the repository name to
  search your recent repositories (**View all repositories** lists them with their folders; the three
  icons open, clone or create one). Click the branch name to search the branches and switch with one
  click; type to also find remote branches. Open the command palette (`Ctrl+K`) for the repository
  actions that used to live in that menu: remotes, search, file manager, terminal, editor, close.
- Beside the branch is **conflict detection**: it asks git whether the current branch would merge cleanly
  into the main branch (`origin/main`, else `origin/master`, `main` or `master`) and updates whenever
  either moves. Hover it for the answer, with the files that would clash. **Press it to merge** the current
  branch into the main branch: after a confirmation that repeats the conflict check, Perseus checks the
  main branch out (creating it from the remote if needed) and merges into it. On conflicts you resolve
  or abort from the Changes tab, as for any merge; undo (`Ctrl+Z`) takes the merge back. It needs git
  2.38 or newer and is off on the main branch itself.
- In the centre: **Undo, Redo, Fetch, Pull, Push, Branch, Stash and Pop** (Pop applies the newest stash
  and removes it). In a narrower window the buttons lose their labels (hover for the name), then the
  command search shrinks to its icon.
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
- **Cherry-pick several commits**: `Ctrl`+click commits in the graph to pick them one by one, or `Shift`+click
  to take the range from the selected one, then right-click → *Cherry-pick N commits onto…*. A dialog lists them
  oldest first: change the order with the arrows, leave some out, or tick *Combine them into a single commit*
  and write its message. If one conflicts the pick stops there and continues after you resolve it, with the usual
  banner. Merge commits are left out (pick the commits they merged).
- **Gitflow** (palette: *Gitflow: set up…*, *start a feature / release / hotfix…*, *finish the current branch…*):
  set up names the main and develop branches and the prefixes (creating develop if needed) and stores them with
  the same keys `git flow init` uses, so either tool works on the repository. Starting a feature or release
  branches from develop, a hotfix from the main branch. Finishing merges a feature into develop; a release or
  hotfix goes into main, is tagged, and goes back into develop; the branch is removed unless you keep it. If a
  merge stops on conflicts, resolve and continue, then finish again: steps already done are skipped. Once set up,
  the sidebar lists the open branches with a finish button.
- **Reset**, **revert**, **tags** and **discard changes** are on the context menus. Discarding
  always asks first. Tags can be pushed one by one to the remote (`origin`, or the repository's only remote),
  deleted there, or all pushed from the Push menu.

## Finding things

- The graph handles very long histories: past about 285,000 rows the scroll bar is stretched so the last
  commit is still reachable (browsers cannot scroll an area that tall). The mouse wheel keeps moving by rows;
  drag the scroll bar, or use `Home`, `End` and the page keys, to cover distance.
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

**Fork** (the link under the pull requests, or the palette's *Fork … on …*) copies the repository to your
account, or to an organization (GitHub) or group (GitLab) you name, under the same name or another one, and adds the
copy as a remote named after its owner. Choose *Make the fork origin* to follow the usual contributor setup:
the fork becomes `origin`, the original is kept as `upstream`, pushes go to the fork and pulls still follow the
original. The address of the new remote comes from the host's answer, and uses SSH when your `origin` does. The
host may need a moment before a new fork can be fetched. Forking needs a signed-in profile; asking again for an
existing fork gives you that fork.

## Submodules, worktrees and LFS

- **Submodules** appear in the sidebar with a marker when they are not downloaded or sit on a
  different commit than the project records. Double-click one to open it as its own tab; *Update all
  submodules* downloads and checks them out. *Add a submodule…* (sidebar, or the palette) takes an address or
  a folder on your computer and a folder inside the repository; the change is staged, so commit it.
- **Worktrees**: right-click a branch → *Check out in a new worktree…*, pick a parent folder, and
  Perseus creates `<folder>/<branch>`. Linked worktrees are listed in the sidebar; double-click to
  open, or remove one with the bin icon.
- **Git LFS**: the sidebar lists the patterns the repository tracks; if `git lfs` is installed you can
  track a new pattern.

## Settings

The gear in the toolbar (`Ctrl+,`, or `⌘,` on a Mac, or *Settings…* in the palette) opens Settings as a page of its own, laid out
like GitKraken's preferences: sections on the left, the chosen one on the right, everything saved the moment it
changes. `Esc` or *Exit Settings* goes back to where you were.

- **General**: auto-fetch interval (off by default), auto-prune, the default branch name for new repositories and
  the large-file warning.
- **Profiles** and **Integrations**: who you commit as and which hosts you are signed in to, with a shortcut to
  manage them.
- **UI Customization**: language, theme (dark, light or follow the system), colours (Slate or Indigo, each with a
  dark and a light version), zoom, toolbar labels, date format, which graph columns show, the ghost branch on
  hover, the coloured row bands, and profile pictures.
- **Keyboard shortcuts**: every shortcut that can move, with a recorder (see below).
- **Activity log**: every git command Perseus ran, with timing and the first line of any error. Passwords inside
  URLs are replaced by `***`. The log lives in memory only.
- **Repo-specific** (for the open repository): the profile it always uses, push after each commit, skip hooks by
  default, and the Git LFS patterns.

Profile pictures: for repositories on github.com, the picture of the GitHub account linked to each commit is
shown (GitHub's own commit record answers this, so it works even when the author's address is private), plus
your own signed-in account. Branches that exist on the remote show the remote owner's picture. Gravatar, which
covers people GitHub does not know, is a separate opt-in because it sends a hash of each address to a third
party. A setting turns all pictures off.

## Keyboard shortcuts

Press `?` for the full list. On a Mac `Ctrl` below is `⌘`. The most useful: `Ctrl+K` palette, `Ctrl+O` open,
`Ctrl+F` search, `Ctrl+B` sidebar, `F5` refresh, `Ctrl+Enter` commit, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom,
`Esc` close the diff. In the graph, the arrow keys, Page Up/Down and Home/End move between commits, and the
menu key (or `Shift+F10`) opens the selected commit's context menu.

To change one, open *Settings → Keyboard shortcuts*, press **Change** next to the action and then the keys you
want. A combination that something else already uses is shown first and only taken when you confirm; a bare
letter is refused, since it would be typed into text boxes. The ✕ removes a shortcut, the arrow restores its
default, and *Restore all defaults* undoes everything. Changes apply at once and are remembered.

Perseus can also speak Portuguese (Portugal): *Settings → UI Customization → Language*. Not every message is
translated yet; see `docs/localisation.md`. For keyboard, screen-reader and contrast details see
`docs/accessibility.md`.

## Where your data lives

- Profiles and recent repositories: the application data folder
  (`%APPDATA%\dev.perseus.app` on Windows). Set `PERSEUS_DATA_DIR` to use another folder.
- Tokens: the operating system keychain, never a file.
- Crash log: if Perseus ever panics, a line describing it is appended to `perseus.log` in that same
  folder (rotated at 256 KB). It stays on your computer; attach it to a bug report if you want to.
- Preferences such as pane sizes and theme: the web view's local storage.
- Perseus makes no network requests of its own except to the Git hosts and OAuth providers you use.
