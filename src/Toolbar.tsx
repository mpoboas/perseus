import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  CircleHelp,
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
  Cable,
} from "lucide-react";
import type { ProfilesSnapshot, PullMode, RecentRepo, RepoInfo, RepoStatus } from "./ipc";
import type { ThemePref } from "./lib/theme";
import { Avatar, Button, IconButton, MenuButton, type MenuItem, Shortcut, Tooltip } from "./ui";

interface Props {
  repo: RepoInfo | null;
  status: RepoStatus | null;
  busy: boolean;
  loading: boolean;
  recents: RecentRepo[];
  profiles: ProfilesSnapshot | null;
  sidebarOpen: boolean;
  theme: ThemePref;
  onToggleSidebar: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onCloseRepo: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  /** The default for the Pull button: refuse, merge or rebase when history has diverged. */
  pullMode: PullMode;
  onPullMode: (m: PullMode) => void;
  /** "force" pushes with a lease (confirmed first), "tags" pushes all tags. */
  onPushVariant: (v: "force" | "tags") => void;
  onRemotes: () => void;
  onStash: () => void;
  onPalette: () => void;
  onCancelLoad: () => void;
  onProfiles: () => void;
  onSwitchProfile: (id: string | null) => void;
  onTheme: (t: ThemePref) => void;
  onShortcuts: () => void;
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

  const repoItems: MenuItem[] = [
    ...(p.recents.filter((r) => r.exists && r.path !== repo?.path).length > 0
      ? ([{ id: "sec", section: "Recent" }] as MenuItem[])
      : []),
    ...p.recents
      .filter((r) => r.exists && r.path !== repo?.path)
      .slice(0, 8)
      .map((r): MenuItem => ({ id: `r:${r.path}`, label: r.name, hint: r.path.split(/[\\/]/).slice(-2, -1)[0], icon: FolderOpen })),
    { id: "sep", separator: true },
    { id: "open", label: "Open repository…", icon: FolderOpen, shortcut: "Ctrl+O" },
    ...(repo
      ? ([
          { id: "remotes", label: "Manage remotes…", icon: Cable },
          { id: "stash", label: "Stash changes…", icon: Archive },
        ] as MenuItem[])
      : []),
    ...(repo ? ([{ id: "close", label: "Close repository", icon: X }] as MenuItem[]) : []),
  ];

  const profileItems: MenuItem[] = [
    { id: "sec", section: "Commit as" },
    { id: "p:", label: "System default", checked: !p.profiles?.active },
    ...(p.profiles?.profiles.map(
      (x): MenuItem => ({ id: `p:${x.id}`, label: x.name, hint: x.user_email, checked: x.id === p.profiles?.active }),
    ) ?? []),
    { id: "sep", separator: true },
    { id: "manage", label: "Manage profiles…", icon: Users },
  ];

  const themeItems: MenuItem[] = THEME_ITEMS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, checked: p.theme === t.id }));
  const ThemeIcon = THEME_ITEMS.find((t) => t.id === p.theme)?.icon ?? Monitor;

  return (
    <header className="toolbar">
      <div className="tb-group">
        {repo && (
          <IconButton
            icon={PanelLeft}
            label={p.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            shortcut="Ctrl+B"
            active={p.sidebarOpen}
            onClick={p.onToggleSidebar}
          />
        )}
        <MenuButton
          items={repoItems}
          minWidth={260}
          onPick={(id) => {
            if (id === "open") p.onOpen();
            else if (id === "remotes") p.onRemotes();
            else if (id === "stash") p.onStash();
            else if (id === "close") p.onCloseRepo();
            else if (id.startsWith("r:")) p.onOpenRecent(id.slice(2));
          }}
          render={({ open, ...props }) => (
            <button className={open ? "chip-btn open" : "chip-btn"} disabled={busy} {...props}>
              <FolderOpen size={14} />
              <span className="chip-text">{repo ? repo.name : "Open a repository"}</span>
              <ChevronDown size={13} />
            </button>
          )}
        />
        {repo && status && (
          <Tooltip label={status.upstream ? `Tracking ${status.upstream}` : "No upstream branch"}>
            <span className="chip branch-chip">
              <GitBranch size={14} />
              <span className="chip-text">{status.branch ?? "detached HEAD"}</span>
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
            </span>
          </Tooltip>
        )}
      </div>

      {repo && (
        <div className="tb-group tb-actions" role="group" aria-label="Remote actions">
          <Button icon={RefreshCw} disabled={busy} onClick={p.onFetch}>
            Fetch
          </Button>
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
            <Button icon={ArrowUpFromLine} disabled={busy || !status?.branch} onClick={p.onPush}>
              {publish ? "Publish" : "Push"}
              {!!status?.ahead && status.upstream && <span className="count-pill">{status.ahead}</span>}
            </Button>
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
            else if (id.startsWith("p:")) p.onSwitchProfile(id.slice(2) || null);
          }}
          render={({ open, ...props }) => (
            <button className={open ? "chip-btn open" : "chip-btn"} disabled={busy} aria-label="Active profile" {...props}>
              <Avatar name={activeProfile?.user_name ?? "Git"} size={20} />
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
      </div>
    </header>
  );
}
