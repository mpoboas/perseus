import { type ComponentType, useEffect, useState } from "react";
import { ArrowLeft, GitCommitHorizontal, HardDrive, Keyboard, Palette, Plug, ScrollText, Settings, UserCog, Users } from "lucide-react";
import type { ProfilesSnapshot, RepoInfo } from "../ipc";
import { type Key, useT } from "../i18n";
import type { ThemePref } from "../lib/theme";
import { Avatar } from "../ui";
import {
  ActivityPage,
  AppearancePage,
  CommitPage,
  GeneralPage,
  IdentityPage,
  IntegrationsPage,
  LfsPage,
  NoRepository,
  ProfilesPage,
} from "./pages";
import { ShortcutsPage } from "./ShortcutsPage";

export type PageId = "general" | "profiles" | "integrations" | "appearance" | "shortcuts" | "activity" | "identity" | "commit" | "lfs";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;
type NavItem = { id: PageId; title: Key; icon: IconType };

const GLOBAL: NavItem[] = [
  { id: "general", title: "settings.page.general", icon: Settings },
  { id: "profiles", title: "settings.page.profiles", icon: Users },
  { id: "integrations", title: "settings.page.integrations", icon: Plug },
  { id: "appearance", title: "settings.page.appearance", icon: Palette },
  { id: "shortcuts", title: "settings.page.shortcuts", icon: Keyboard },
  { id: "activity", title: "settings.page.activity", icon: ScrollText },
];

const REPO: NavItem[] = [
  { id: "identity", title: "settings.page.identity", icon: UserCog },
  { id: "commit", title: "settings.page.commit", icon: GitCommitHorizontal },
  { id: "lfs", title: "settings.page.lfs", icon: HardDrive },
];

interface Props {
  repo: RepoInfo | null;
  profiles: ProfilesSnapshot | null;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  initialPage?: PageId;
  onExit: () => void;
  onManageProfiles: () => void;
  onSwitchProfile: (id: string | null) => void;
}

/**
 * Settings as a page of their own, laid out like GitKraken's preferences: a list of sections on
 * the left (global ones, then the ones that belong to the open repository) and the chosen section
 * on the right. Everything saves as soon as it changes.
 */
export function SettingsPage({ repo, profiles, theme, onTheme, initialPage = "general", onExit, onManageProfiles, onSwitchProfile }: Props) {
  const t = useT();
  const [page, setPage] = useState<PageId>(initialPage);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === "Escape" && !typing && !document.querySelector('[role="dialog"], [role="menu"]')) onExit();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onExit]);

  const titleKey = [...GLOBAL, ...REPO].find((p) => p.id === page)?.title;
  const title = titleKey ? t(titleKey) : "";
  const repoPage = REPO.some((p) => p.id === page);
  const active = profiles?.profiles.find((p) => p.id === profiles.active);

  const item = (p: NavItem) => {
    const Icon = p.icon;
    return (
      <button key={p.id} className={p.id === page ? "set-nav-item active" : "set-nav-item"} aria-current={p.id === page} onClick={() => setPage(p.id)}>
        <Icon size={15} />
        <span>{t(p.title)}</span>
      </button>
    );
  };

  let body: React.ReactNode;
  if (repoPage && !repo) body = <NoRepository />;
  else
    switch (page) {
      case "general":
        body = <GeneralPage />;
        break;
      case "profiles":
        body = <ProfilesPage profiles={profiles} onSwitch={onSwitchProfile} onManage={onManageProfiles} />;
        break;
      case "integrations":
        body = <IntegrationsPage profiles={profiles} onManage={onManageProfiles} />;
        break;
      case "appearance":
        body = <AppearancePage theme={theme} onTheme={onTheme} />;
        break;
      case "shortcuts":
        body = <ShortcutsPage />;
        break;
      case "activity":
        body = <ActivityPage />;
        break;
      case "identity":
        body = repo && <IdentityPage repo={repo} profiles={profiles} onSwitch={onSwitchProfile} />;
        break;
      case "commit":
        body = repo && <CommitPage repo={repo} />;
        break;
      case "lfs":
        body = repo && <LfsPage repo={repo} />;
        break;
    }

  return (
    <div className="settings" role="region" aria-label={t("settings.region")}>
      <nav className="set-nav" aria-label={t("settings.sections")}>
        <button className="set-exit" onClick={onExit}>
          <ArrowLeft size={15} />
          <span>{t("settings.exit")}</span>
        </button>

        <div className="set-nav-group">
          <span className="set-nav-label">{t("settings.currentProfile")}</span>
          <div className="set-profile">
            <Avatar name={active?.user_name ?? "Git"} email={active?.user_email} size={22} />
            <strong>{active ? active.name : t("settings.systemDefault")}</strong>
          </div>
        </div>

        <div className="set-nav-group">
          <span className="set-nav-label">{t("settings.preferences")}</span>
          {GLOBAL.map(item)}
        </div>

        <div className="set-nav-group">
          <span className="set-nav-label">{t("settings.repoPreferences")}</span>
          <span className="set-nav-repo">{repo ? repo.name : t("settings.noRepository")}</span>
          {REPO.map(item)}
        </div>
      </nav>

      <main className="set-main">
        <h2>{title}</h2>
        <div className="set-page">{body}</div>
      </main>
    </div>
  );
}
