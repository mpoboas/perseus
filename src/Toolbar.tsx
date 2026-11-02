import { useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ArchiveRestore,
  Redo2,
  Undo2,
  GitBranchPlus,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  Cloud,
  FolderOpen,
  GitBranch,
  Monitor,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  Sun,
  Users,
  X,
  Archive,
  Download,
  Eye,
  Pin,
  Settings,
  FolderPlus,
  Star,
} from "lucide-react";
import { ConflictButton } from "./ConflictButton";
import type { ProfilesSnapshot, PullMode, RecentRepo, RefInfo, RepoInfo, RepoStatus } from "./ipc";
import { undoName } from "./lib/format";
import { repoLabel, splitRecents } from "./lib/repos";
import type { ThemePref } from "./lib/theme";
import { Avatar, Button, IconButton, MenuButton, type MenuItem, Shortcut, Tooltip } from "./ui";
import { Picker } from "./ui/Picker";

interface Props {
  repo: RepoInfo | null;
  status: RepoStatus | null;
  busy: boolean;
  loading: boolean;
  recents: RecentRepo[];
  refs: RefInfo[];
  profiles: ProfilesSnapshot | null;
  sidebarOpen: boolean;
  theme: ThemePref;
  onToggleSidebar: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  /** Switches to a branch (a remote one gets a tracking branch). */
  onCheckout: (r: RefInfo) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  /** The default for the Pull button: refuse, merge or rebase when history has diverged. */
  pullMode: PullMode;
  onPullMode: (m: PullMode) => void;
  /** "force" pushes with a lease (confirmed first), "tags" pushes all tags. */
  onPushVariant: (v: "force" | "tags") => void;
  onStash: () => void;
  onNewBranch: () => void;
  /** The conflict button: merge the current branch into the main branch (`ref` is the branch it was checked against). */
  onMergeIntoMain: (branch: string, ref: string) => void;
  /** What the next undo or redo would act on (null when there is nothing to do). */
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  /** Applies the newest stash and removes it. */
  onPop: () => void;
  stashCount: number;
  onClone: () => void;
  onInit: () => void;
  /** How many refs are hidden (or soloed) in the graph; 0 means no filter. */
  filterCount: number;
  onClearFilter: () => void;
  onPalette: () => void;
  onCancelLoad: () => void;
  onProfiles: () => void;
  onSwitchProfile: (id: string | null) => void;
  /** Remember the active profile for this repository. */
  onPinProfile: () => void;
  onTheme: (t: ThemePref) => void;
  onShortcuts: () => void;
  onPreferences: () => void;
}

const THEME_ITEMS: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function Toolbar(p: Props) {
  const { repo, status, busy } = p;
  const publish = !!status?.branch && !status.upstream;
  const activeProfile = p.profiles?.profiles.find((x) => x.id === p.profiles?.active) ?? null;

  const [showAllRepos, setShowAllRepos] = useState(false);
  const recentRepos = p.recents.filter((r) => r.exists && r.path !== repo?.path);
  const listed = repo ? p.recents.find((r) => r.path === repo.path) : undefined;
  const repoName = repo ? (listed ? repoLabel(listed) : repo.name) : "Open a repository";
  const localBranches = p.refs.filter((r) => r.kind === "branch").sort((a, b) => a.name.localeCompare(b.name));
  // A remote branch with no local twin can still be switched to: git makes the tracking branch.
  const remoteOnly = p.refs.filter(
    (r) => r.kind === "remote" && !r.name.endsWith("/HEAD") && !localBranches.some((l) => l.name === r.name.split("/").slice(1).join("/")),
  );

  const profileItems: MenuItem[] = [
    { id: "sec", section: "Commit as" },
    { id: "p:", label: "System default", checked: !p.profiles?.active },
    ...(p.profiles?.profiles.map(
      (x): MenuItem => ({ id: `p:${x.id}`, label: x.name, hint: x.user_email, checked: x.id === p.profiles?.active }),
    ) ?? []),
    { id: "sep", separator: true },
    ...(repo && activeProfile ? ([{ id: "pin", label: `Always use ${activeProfile.name} for ${repo.name}`, icon: Pin }] as MenuItem[]) : []),
    { id: "manage", label: "Manage profiles…", icon: Users },
  ];

  const themeItems: MenuItem[] = THEME_ITEMS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, checked: p.theme === t.id }));
  const ThemeIcon = THEME_ITEMS.find((t) => t.id === p.theme)?.icon ?? Monitor;

  return (
    <header className="toolbar">
      <div className="tb-group tb-left">
        {repo && (
          <IconButton
            icon={PanelLeft}
            label={p.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            shortcut="Ctrl+B"
            active={p.sidebarOpen}
            onClick={p.onToggleSidebar}
          />
        )}
        <Picker
          caption="repository"
          value={repoName}
          ariaLabel="Switch repository"
          disabled={busy}
          placeholder="Search"
          width={290}
        >
          {({ query, close }) => {
            const q = query.toLowerCase();
            const matching = recentRepos.filter(
              (r) => !q || r.name.toLowerCase().includes(q) || repoLabel(r).toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
            );
            const { favorites, others } = splitRecents(matching);
            const shown = q || showAllRepos ? others : others.slice(0, 8);
            const row = (r: RecentRepo) => (
              <div key={r.path} className="pk-row">
                <button
                  className="pk-item"
                  title={r.alias ? `${r.name} — ${r.path}` : r.path}
                  onClick={() => {
                    close();
                    p.onOpenRecent(r.path);
                  }}
                >
                  <span className="pk-name">{repoLabel(r)}</span>
                  {(q || showAllRepos) && <span className="pk-hint">{r.path.split(/[\\/]/).slice(-2, -1)[0]}</span>}
                </button>
                <button
                  className={r.favorite ? "pk-star on" : "pk-star"}
                  aria-label={r.favorite ? `Remove ${repoLabel(r)} from favorites` : `Add ${repoLabel(r)} to favorites`}
                  aria-pressed={r.favorite}
                  onClick={() => p.onToggleFavorite(r.path, !r.favorite)}
                >
                  <Star size={13} fill={r.favorite ? "currentColor" : "none"} />
                </button>
              </div>
            );
            return (
              <>
                {favorites.length > 0 && (
                  <>
                    <div className="pk-head">
                      <Star size={13} />
                      Favorites
                    </div>
                    {favorites.map(row)}
                  </>
                )}
                <div className="pk-head">
                  <Clock size={13} />
                  Recently opened
                </div>
                {shown.map(row)}
                {shown.length === 0 && favorites.length === 0 && (
                  <div className="pk-empty">{q ? "No repositories match" : "No other repositories yet"}</div>
                )}
                {shown.length === 0 && favorites.length > 0 && <div className="pk-empty">Nothing else yet</div>}
                <div className="pk-foot">
                  {!q ? (
                    <button className="pk-link" onClick={() => setShowAllRepos((v) => !v)}>
                      {showAllRepos ? "Show fewer" : "View all repositories"}
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className="pk-foot-actions">
                    <IconButton
                      icon={FolderOpen}
                      label="Open a repository…"
                      shortcut="Ctrl+O"
                      onClick={() => {
                        close();
                        p.onOpen();
                      }}
                    />
                    <IconButton
                      icon={Download}
                      label="Clone a repository…"
                      onClick={() => {
                        close();
                        p.onClone();
                      }}
                    />
                    <IconButton
                      icon={FolderPlus}
                      label="Create a new repository…"
                      onClick={() => {
                        close();
                        p.onInit();
                      }}
                    />
                  </span>
                </div>
              </>
            );
          }}
        </Picker>
        {repo && p.filterCount > 0 && (
          <button className="chip filter-chip" onClick={p.onClearFilter} title="Show every branch again">
            <Eye size={13} />
            <span className="chip-text">Graph filtered ({p.filterCount})</span>
            <X size={12} />
          </button>
        )}
        {repo && status && (
          <>
            <ChevronRight size={15} className="pk-sep" aria-hidden="true" />
            <Picker
              caption="branch"
              value={status.branch ?? "detached HEAD"}
              ariaLabel="Switch branch"
              tooltip={status.upstream ? `Tracking ${status.upstream}` : "No upstream branch"}
              disabled={busy}
              placeholder="Search"
              width={270}
              extra={
                <>
                  {status.upstream && status.ahead > 0 && (
                    <span className="ab ahead">
                      <ArrowUp size={11} />
                      {status.ahead}
                    </span>
                  )}
                  {status.upstream && status.behind > 0 && (
                    <span className="ab behind">
                      <ArrowDown size={11} />
                      {status.behind}
                    </span>
                  )}
                </>
              }
            >
              {({ query, close }) => {
                const q = query.toLowerCase();
                const local = localBranches.filter((r) => r.name.toLowerCase().includes(q));
                const remote = q ? remoteOnly.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 40) : [];
                const pick = (r: RefInfo) => {
                  close();
                  if (!r.is_head) p.onCheckout(r);
                };
                return (
                  <>
                    {local.map((r) => (
                      <button
                        key={r.name}
                        className={r.is_head ? "pk-item current" : "pk-item"}
                        onClick={() => pick(r)}
                        title={r.upstream ? `Tracking ${r.upstream}` : undefined}
                      >
                        <GitBranch size={14} className="pk-icon" />
                        <span className="pk-name">{r.name}</span>
                      </button>
                    ))}
                    {remote.map((r) => (
                      <button key={r.name} className="pk-item" onClick={() => pick(r)} title="Remote branch: creates a local tracking branch">
                        <Cloud size={14} className="pk-icon" />
                        <span className="pk-name">{r.name}</span>
                      </button>
                    ))}
                    {local.length + remote.length === 0 && <div className="pk-empty">No branches match</div>}
                  </>
                );
              }}
            </Picker>
            <ConflictButton repoId={repo.id} branch={status.branch} refs={p.refs} onMerge={p.onMergeIntoMain} disabled={busy} />
          </>
        )}
      </div>

      <div className="tb-spacer" />

      {repo && (
        <div className="tb-group tb-actions" role="group" aria-label="Remote actions">
          <Tooltip label={p.undoLabel ? `Undo ${undoName(p.undoLabel)} (Ctrl+Z)` : "Nothing to undo"}>
            <Button icon={Undo2} disabled={busy || !p.undoLabel} onClick={p.onUndo}>
              Undo
            </Button>
          </Tooltip>
          <Tooltip label={p.redoLabel ? `Redo ${undoName(p.redoLabel)} (Ctrl+Shift+Z)` : "Nothing to redo"}>
            <Button icon={Redo2} disabled={busy || !p.redoLabel} onClick={p.onRedo}>
              Redo
            </Button>
          </Tooltip>
          <div className="tb-sep" aria-hidden="true" />
          <Tooltip label="Fetch from the remotes">
            <Button icon={RefreshCw} disabled={busy} onClick={p.onFetch}>
              Fetch
            </Button>
          </Tooltip>
          <div className="split-btn">
            <Tooltip
              label={
                status?.upstream
                  ? { ff_only: "Pull (fast-forward only)", merge: "Pull (merge)", rebase: "Pull (rebase)" }[p.pullMode]
                  : "No upstream branch to pull from"
              }
            >
              <Button icon={ArrowDownToLine} disabled={busy || !status?.upstream} onClick={p.onPull}>
                Pull
                {!!status?.behind && <span className="count-pill">{status.behind}</span>}
              </Button>
            </Tooltip>
            <MenuButton
              align="end"
              minWidth={250}
              items={[
                { id: "sec", section: "When history has diverged" },
                { id: "ff_only", label: "Refuse (fast-forward only)", checked: p.pullMode === "ff_only" },
                { id: "merge", label: "Create a merge commit", checked: p.pullMode === "merge" },
                { id: "rebase", label: "Rebase my commits", checked: p.pullMode === "rebase" },
              ]}
              onPick={(id) => p.onPullMode(id as PullMode)}
              render={({ open: _open, ...props }) => (
                <IconButton icon={ChevronDown} label="Pull options" size="md" disabled={busy} {...props} />
              )}
            />
          </div>
          <div className="split-btn">
            <Tooltip label={publish ? "Publish this branch to the remote" : status?.upstream ? `Push to ${status.upstream}` : "Push"}>
              <Button icon={ArrowUpFromLine} disabled={busy || !status?.branch} onClick={p.onPush}>
                {publish ? "Publish" : "Push"}
                {!!status?.ahead && status.upstream && <span className="count-pill">{status.ahead}</span>}
              </Button>
            </Tooltip>
            <MenuButton
              align="end"
              minWidth={250}
              items={[
                { id: "force", label: "Force push (with lease)…", danger: true, disabled: !status?.upstream },
                { id: "tags", label: "Push all tags" },
              ]}
              onPick={(id) => p.onPushVariant(id as "force" | "tags")}
              render={({ open: _open, ...props }) => (
                <IconButton icon={ChevronDown} label="Push options" size="md" disabled={busy || !status?.branch} {...props} />
              )}
            />
          </div>
          <div className="tb-sep" aria-hidden="true" />
          <Tooltip label="Create a branch here">
            <Button icon={GitBranchPlus} disabled={busy} onClick={p.onNewBranch}>
              Branch
            </Button>
          </Tooltip>
          <Tooltip label="Stash your changes">
            <Button icon={Archive} disabled={busy || !status?.entries.length} onClick={p.onStash}>
              Stash
            </Button>
          </Tooltip>
          <Tooltip label={p.stashCount > 0 ? "Apply the newest stash and remove it" : "No stashes to pop"}>
            <Button icon={ArchiveRestore} disabled={busy || p.stashCount === 0} onClick={p.onPop}>
              Pop
              {p.stashCount > 0 && <span className="count-pill">{p.stashCount}</span>}
            </Button>
          </Tooltip>
          {p.loading && (
            <Button variant="ghost" icon={X} onClick={p.onCancelLoad}>
              Stop loading
            </Button>
          )}
        </div>
      )}

      <div className="tb-spacer" />

      <div className="tb-group">
        <button className="search-btn" onClick={p.onPalette} aria-label="Open command palette">
          <Search size={14} />
          <span>Search commands</span>
          <Shortcut keys="Ctrl+K" />
        </button>

        <MenuButton
          items={profileItems}
          align="end"
          minWidth={260}
          onPick={(id) => {
            if (id === "manage") p.onProfiles();
            else if (id === "pin") p.onPinProfile();
            else if (id.startsWith("p:")) p.onSwitchProfile(id.slice(2) || null);
          }}
          render={({ open, ...props }) => (
            <button className={open ? "chip-btn open" : "chip-btn"} disabled={busy} aria-label="Active profile" {...props}>
              <Avatar name={activeProfile?.user_name ?? "Git"} email={activeProfile?.user_email} size={20} />
              <span className="chip-text">{activeProfile ? activeProfile.name : "System default"}</span>
              <ChevronDown size={13} />
            </button>
          )}
        />

        <MenuButton
          items={themeItems}
          align="end"
          minWidth={160}
          onPick={(id) => p.onTheme(id as ThemePref)}
          render={({ open: _open, ...props }) => (
            <Tooltip label="Theme">
              <button className="icon-btn" aria-label="Theme" {...props}>
                <ThemeIcon size={16} />
              </button>
            </Tooltip>
          )}
        />
        <IconButton icon={CircleHelp} label="Keyboard shortcuts" shortcut="?" onClick={p.onShortcuts} />
        <IconButton icon={Settings} label="Settings" shortcut="Ctrl+," onClick={p.onPreferences} />
      </div>
    </header>
  );
}
