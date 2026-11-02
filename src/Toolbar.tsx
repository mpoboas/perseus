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
} from "lucide-react";
import type { ProfilesSnapshot, RecentRepo, RepoInfo, RepoStatus } from "./ipc";
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
          <Tooltip label={status?.upstream ? "Fast-forward only" : "No upstream branch to pull from"}>
            <Button icon={ArrowDownToLine} disabled={busy || !status?.upstream} onClick={p.onPull}>
              Pull
              {!!status?.behind && <span className="count-pill">{status.behind}</span>}
            </Button>
          </Tooltip>
          <Button icon={ArrowUpFromLine} disabled={busy || !status?.branch} onClick={p.onPush}>
            {publish ? "Publish" : "Push"}
            {!!status?.ahead && status.upstream && <span className="count-pill">{status.ahead}</span>}
          </Button>
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
