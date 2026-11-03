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
import { type Key, useT } from "./i18n";
import { undoName } from "./lib/format";
import { repoLabel, splitRecents } from "./lib/repos";
import { bindingText, useBindings } from "./lib/shortcuts";
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

const THEME_ITEMS = [
  { id: "system", label: "tb.themeSystem", icon: Monitor },
  { id: "light", label: "tb.themeLight", icon: Sun },
  { id: "dark", label: "tb.themeDark", icon: Moon },
] as const satisfies readonly { id: ThemePref; label: Key; icon: typeof Sun }[];

export function Toolbar(p: Props) {
  const t = useT();
  const keys = useBindings();
  const { repo, status, busy } = p;
  const publish = !!status?.branch && !status.upstream;
  const activeProfile = p.profiles?.profiles.find((x) => x.id === p.profiles?.active) ?? null;

  const [showAllRepos, setShowAllRepos] = useState(false);
  const recentRepos = p.recents.filter((r) => r.exists && r.path !== repo?.path);
  const listed = repo ? p.recents.find((r) => r.path === repo.path) : undefined;
  const repoName = repo ? (listed ? repoLabel(listed) : repo.name) : t("tb.noRepository");
  const localBranches = p.refs.filter((r) => r.kind === "branch").sort((a, b) => a.name.localeCompare(b.name));
  // A remote branch with no local twin can still be switched to: git makes the tracking branch.
  const remoteOnly = p.refs.filter(
    (r) => r.kind === "remote" && !r.name.endsWith("/HEAD") && !localBranches.some((l) => l.name === r.name.split("/").slice(1).join("/")),
  );

  const profileItems: MenuItem[] = [
    { id: "sec", section: t("tb.commitAs") },
    { id: "p:", label: t("tb.systemDefault"), checked: !p.profiles?.active },
    ...(p.profiles?.profiles.map(
      (x): MenuItem => ({ id: `p:${x.id}`, label: x.name, hint: x.user_email, checked: x.id === p.profiles?.active }),
    ) ?? []),
    { id: "sep", separator: true },
    ...(repo && activeProfile ? ([{ id: "pin", label: t("tb.alwaysUse", { profile: activeProfile.name, repo: repo.name }), icon: Pin }] as MenuItem[]) : []),
    { id: "manage", label: t("tb.manageProfiles"), icon: Users },
  ];

  const themeItems: MenuItem[] = THEME_ITEMS.map((x) => ({ id: x.id, label: t(x.label), icon: x.icon, checked: p.theme === x.id }));
  const ThemeIcon = THEME_ITEMS.find((t) => t.id === p.theme)?.icon ?? Monitor;

  return (
    <header className="toolbar">
      <div className="tb-group tb-left">
        {repo && (
          <IconButton
            icon={PanelLeft}
            label={t(p.sidebarOpen ? "tb.hideSidebar" : "tb.showSidebar")}
            shortcut={keys.sidebar[0]}
            active={p.sidebarOpen}
            onClick={p.onToggleSidebar}
          />
        )}
        <Picker
          caption={t("tb.captionRepository")}
          value={repoName}
          ariaLabel={t("tb.switchRepository")}
          disabled={busy}
          placeholder={t("tb.search")}
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
                  aria-label={t(r.favorite ? "welcome.removeFavorite" : "welcome.addFavorite", { name: repoLabel(r) })}
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
                      {t("tb.favorites")}
                    </div>
                    {favorites.map(row)}
                  </>
                )}
                <div className="pk-head">
                  <Clock size={13} />
                  {t("tb.recentlyOpened")}
                </div>
                {shown.map(row)}
                {shown.length === 0 && favorites.length === 0 && (
                  <div className="pk-empty">{t(q ? "tb.noRepositoriesMatch" : "tb.noOtherRepositories")}</div>
                )}
                {shown.length === 0 && favorites.length > 0 && <div className="pk-empty">{t("tb.nothingElse")}</div>}
                <div className="pk-foot">
                  {!q ? (
                    <button className="pk-link" onClick={() => setShowAllRepos((v) => !v)}>
                      {t(showAllRepos ? "tb.showFewer" : "tb.viewAll")}
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className="pk-foot-actions">
                    <IconButton
                      icon={FolderOpen}
                      label={t("tb.open")}
                      shortcut={keys.open[0]}
                      onClick={() => {
                        close();
                        p.onOpen();
                      }}
                    />
                    <IconButton
                      icon={Download}
                      label={t("tb.clone")}
                      onClick={() => {
                        close();
                        p.onClone();
                      }}
                    />
                    <IconButton
                      icon={FolderPlus}
                      label={t("tb.create")}
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
          <button className="chip filter-chip" onClick={p.onClearFilter} title={t("tb.showAllBranches")}>
            <Eye size={13} />
            <span className="chip-text">{t("tb.graphFiltered", { count: p.filterCount })}</span>
            <X size={12} />
          </button>
        )}
        {repo && status && (
          <>
            <ChevronRight size={15} className="pk-sep" aria-hidden="true" />
            <Picker
              caption={t("tb.captionBranch")}
              value={status.branch ?? t("tb.detachedHead")}
              ariaLabel={t("tb.switchBranch")}
              tooltip={status.upstream ? t("tb.tracking", { upstream: status.upstream }) : t("tb.noUpstream")}
              disabled={busy}
              placeholder={t("tb.search")}
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
                        title={r.upstream ? t("tb.tracking", { upstream: r.upstream }) : undefined}
                      >
                        <GitBranch size={14} className="pk-icon" />
                        <span className="pk-name">{r.name}</span>
                      </button>
                    ))}
                    {remote.map((r) => (
                      <button key={r.name} className="pk-item" onClick={() => pick(r)} title={t("tb.remoteBranchTip")}>
                        <Cloud size={14} className="pk-icon" />
                        <span className="pk-name">{r.name}</span>
                      </button>
                    ))}
                    {local.length + remote.length === 0 && <div className="pk-empty">{t("tb.noBranchesMatch")}</div>}
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
        <div className="tb-group tb-actions" role="group" aria-label={t("tb.remoteActions")}>
          <Tooltip label={p.undoLabel ? `${t("tb.undoNamed", { what: undoName(p.undoLabel) })}${keys.undo[0] ? ` (${bindingText(keys.undo[0])})` : ""}` : t("tb.nothingToUndo")}>
            <Button icon={Undo2} disabled={busy || !p.undoLabel} onClick={p.onUndo}>
              {t("tb.undo")}
            </Button>
          </Tooltip>
          <Tooltip label={p.redoLabel ? `${t("tb.redoNamed", { what: undoName(p.redoLabel) })}${keys.redo[0] ? ` (${bindingText(keys.redo[0])})` : ""}` : t("tb.nothingToRedo")}>
            <Button icon={Redo2} disabled={busy || !p.redoLabel} onClick={p.onRedo}>
              {t("tb.redo")}
            </Button>
          </Tooltip>
          <div className="tb-sep" aria-hidden="true" />
          <Tooltip label={t("tb.fetchTip")}>
            <Button icon={RefreshCw} disabled={busy} onClick={p.onFetch}>
              {t("tb.fetch")}
            </Button>
          </Tooltip>
          <div className="split-btn">
            <Tooltip
              label={
                status?.upstream
                  ? t({ ff_only: "tb.pullFf", merge: "tb.pullMerge", rebase: "tb.pullRebase" }[p.pullMode] as Key)
                  : t("tb.noUpstreamToPull")
              }
            >
              <Button icon={ArrowDownToLine} disabled={busy || !status?.upstream} onClick={p.onPull}>
                {t("tb.pull")}
                {!!status?.behind && <span className="count-pill">{status.behind}</span>}
              </Button>
            </Tooltip>
            <MenuButton
              align="end"
              minWidth={250}
              items={[
                { id: "sec", section: t("tb.pullWhenDiverged") },
                { id: "ff_only", label: t("tb.pullRefuse"), checked: p.pullMode === "ff_only" },
                { id: "merge", label: t("tb.pullMergeCommit"), checked: p.pullMode === "merge" },
                { id: "rebase", label: t("tb.pullRebaseMine"), checked: p.pullMode === "rebase" },
              ]}
              onPick={(id) => p.onPullMode(id as PullMode)}
              render={({ open: _open, ...props }) => (
                <IconButton icon={ChevronDown} label={t("tb.pullOptions")} size="md" disabled={busy} {...props} />
              )}
            />
          </div>
          <div className="split-btn">
            <Tooltip label={publish ? t("tb.publishTip") : status?.upstream ? t("tb.pushTo", { upstream: status.upstream }) : t("tb.push")}>
              <Button icon={ArrowUpFromLine} disabled={busy || !status?.branch} onClick={p.onPush}>
                {t(publish ? "tb.publish" : "tb.push")}
                {!!status?.ahead && status.upstream && <span className="count-pill">{status.ahead}</span>}
              </Button>
            </Tooltip>
            <MenuButton
              align="end"
              minWidth={250}
              items={[
                { id: "force", label: t("tb.forcePush"), danger: true, disabled: !status?.upstream },
                { id: "tags", label: t("tb.pushTags") },
              ]}
              onPick={(id) => p.onPushVariant(id as "force" | "tags")}
              render={({ open: _open, ...props }) => (
                <IconButton icon={ChevronDown} label={t("tb.pushOptions")} size="md" disabled={busy || !status?.branch} {...props} />
              )}
            />
          </div>
          <div className="tb-sep" aria-hidden="true" />
          <Tooltip label={t("tb.branchTip")}>
            <Button icon={GitBranchPlus} disabled={busy} onClick={p.onNewBranch}>
              {t("tb.branch")}
            </Button>
          </Tooltip>
          <Tooltip label={t("tb.stashTip")}>
            <Button icon={Archive} disabled={busy || !status?.entries.length} onClick={p.onStash}>
              {t("tb.stash")}
            </Button>
          </Tooltip>
          <Tooltip label={t(p.stashCount > 0 ? "tb.popTip" : "tb.noStashes")}>
            <Button icon={ArchiveRestore} disabled={busy || p.stashCount === 0} onClick={p.onPop}>
              {t("tb.pop")}
              {p.stashCount > 0 && <span className="count-pill">{p.stashCount}</span>}
            </Button>
          </Tooltip>
          {p.loading && (
            <Button variant="ghost" icon={X} onClick={p.onCancelLoad}>
              {t("tb.stopLoading")}
            </Button>
          )}
        </div>
      )}

      <div className="tb-spacer" />

      <div className="tb-group">
        <button className="search-btn" onClick={p.onPalette} aria-label={t("tb.openPalette")}>
          <Search size={14} />
          <span>{t("tb.searchCommands")}</span>
          {keys.palette[0] && <Shortcut keys={keys.palette[0]} />}
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
            <button className={open ? "chip-btn open" : "chip-btn"} disabled={busy} aria-label={t("tb.activeProfile")} {...props}>
              <Avatar name={activeProfile?.user_name ?? "Git"} email={activeProfile?.user_email} size={20} />
              <span className="chip-text">{activeProfile ? activeProfile.name : t("tb.systemDefault")}</span>
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
            <Tooltip label={t("tb.theme")}>
              <button className="icon-btn" aria-label={t("tb.theme")} {...props}>
                <ThemeIcon size={16} />
              </button>
            </Tooltip>
          )}
        />
        <IconButton icon={CircleHelp} label={t("tb.shortcuts")} shortcut={keys.help[0]} onClick={p.onShortcuts} />
        <IconButton icon={Settings} label={t("tb.settings")} shortcut={keys.settings[0]} onClick={p.onPreferences} />
      </div>
    </header>
  );
}
