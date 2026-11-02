import { type ComponentType, useEffect, useState } from "react";
import { ArrowLeft, GitCommitHorizontal, HardDrive, Palette, Plug, ScrollText, Settings, UserCog, Users } from "lucide-react";
import type { ProfilesSnapshot, RepoInfo } from "../ipc";
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

export type PageId = "general" | "profiles" | "integrations" | "appearance" | "activity" | "identity" | "commit" | "lfs";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

const GLOBAL: { id: PageId; title: string; icon: IconType }[] = [
  { id: "general", title: "General", icon: Settings },
  { id: "profiles", title: "Profiles", icon: Users },
  { id: "integrations", title: "Integrations", icon: Plug },
  { id: "appearance", title: "UI Customization", icon: Palette },
  { id: "activity", title: "Activity log", icon: ScrollText },
];

const REPO: { id: PageId; title: string; icon: IconType }[] = [
  { id: "identity", title: "Identity", icon: UserCog },
  { id: "commit", title: "Commit", icon: GitCommitHorizontal },
  { id: "lfs", title: "Git LFS", icon: HardDrive },
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

  const title = [...GLOBAL, ...REPO].find((p) => p.id === page)?.title ?? "";
  const repoPage = REPO.some((p) => p.id === page);
  const active = profiles?.profiles.find((p) => p.id === profiles.active);

  const item = (p: { id: PageId; title: string; icon: IconType }) => {
    const Icon = p.icon;
    return (
      <button key={p.id} className={p.id === page ? "set-nav-item active" : "set-nav-item"} aria-current={p.id === page} onClick={() => setPage(p.id)}>
        <Icon size={15} />
        <span>{p.title}</span>
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
    <div className="settings" role="region" aria-label="Settings">
      <nav className="set-nav" aria-label="Settings sections">
        <button className="set-exit" onClick={onExit}>
          <ArrowLeft size={15} />
          <span>Exit Settings</span>
        </button>

        <div className="set-nav-group">
          <span className="set-nav-label">Current profile</span>
          <div className="set-profile">
            <Avatar name={active?.user_name ?? "Git"} email={active?.user_email} size={22} />
            <strong>{active ? active.name : "System default"}</strong>
          </div>
        </div>

        <div className="set-nav-group">
          <span className="set-nav-label">Preferences</span>
          {GLOBAL.map(item)}
        </div>

        <div className="set-nav-group">
          <span className="set-nav-label">Repo-specific preferences</span>
          <span className="set-nav-repo">{repo ? repo.name : "No repository open"}</span>
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
