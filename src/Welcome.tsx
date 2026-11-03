import { Download, FolderOpen, FolderPlus, FolderX, GitBranch, Pencil, Search, Star, X } from "lucide-react";
import type { RecentRepo } from "./ipc";
import { relativeTime } from "./lib/format";
import { repoLabel, splitRecents } from "./lib/repos";
import { useT } from "./i18n";
import { useBindings } from "./lib/shortcuts";
import { Button, IconButton, Shortcut } from "./ui";

interface Props {
  recents: RecentRepo[];
  busy: boolean;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  onRename: (path: string) => void;
  onPalette: () => void;
  onClone: () => void;
  onInit: () => void;
}

/**
 * The Perseus mark (`branding/`): the winged helmet and the commit graph, in its own colours. It is the
 * same artwork as the application icon. `height` is in pixels; the width follows the artwork.
 */
export function Logo({ height = 96 }: { height?: number }) {
  return <img src="/logo.png" alt="Perseus" height={height} className="logo" draggable={false} />;
}

export function Welcome({
  recents,
  busy,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  onToggleFavorite,
  onRename,
  onPalette,
  onClone,
  onInit,
}: Props) {
  const t = useT();
  const keys = useBindings();
  const { favorites, others } = splitRecents(recents);

  const row = (r: RecentRepo) => {
    const label = repoLabel(r);
    return (
      <li key={r.path} className={r.exists ? "recent" : "recent missing"}>
        <button
          className="recent-main"
          disabled={busy || !r.exists}
          onClick={() => onOpenRecent(r.path)}
          title={r.exists ? r.path : t("welcome.folderNotFound", { path: r.path })}
        >
          {r.exists ? <GitBranch size={16} /> : <FolderX size={16} />}
          <span className="recent-text">
            <strong>{label}</strong>
            <span className="recent-path">{r.alias ? `${r.name} · ${r.path}` : r.path}</span>
          </span>
          <span className="recent-time">{r.exists ? relativeTime(r.last_opened) : t("welcome.missing")}</span>
        </button>
        <IconButton
          icon={Star}
          label={t(r.favorite ? "welcome.removeFavorite" : "welcome.addFavorite", { name: label })}
          size="sm"
          active={r.favorite}
          onClick={() => onToggleFavorite(r.path, !r.favorite)}
        />
        <IconButton icon={Pencil} label={t("welcome.rename", { name: label })} size="sm" onClick={() => onRename(r.path)} />
        <IconButton icon={X} label={t("welcome.removeFromList", { name: label })} size="sm" onClick={() => onRemoveRecent(r.path)} />
      </li>
    );
  };

  return (
    <main className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <Logo />
          <h1>Perseus</h1>
          <p>{t("welcome.tagline")}</p>
          <div className="welcome-actions">
            <Button variant="primary" icon={FolderOpen} disabled={busy} onClick={onOpen}>
              {t("welcome.open")}
              {keys.open[0] && <Shortcut keys={keys.open[0]} />}
            </Button>
            <Button icon={Search} onClick={onPalette}>
              {t("welcome.palette")}
              {keys.palette[0] && <Shortcut keys={keys.palette[0]} />}
            </Button>
          </div>
          <div className="welcome-actions secondary">
            <Button variant="ghost" icon={Download} disabled={busy} onClick={onClone}>
              {t("welcome.clone")}
            </Button>
            <Button variant="ghost" icon={FolderPlus} disabled={busy} onClick={onInit}>
              {t("welcome.create")}
            </Button>
          </div>
        </div>

        {favorites.length > 0 && (
          <section className="recents" aria-label={t("welcome.favoritesLabel")}>
            <h2>{t("welcome.favorites")}</h2>
            <ul>{favorites.map(row)}</ul>
          </section>
        )}

        <section className="recents" aria-label={t("welcome.recentLabel")}>
          <h2>{t("welcome.recent")}</h2>
          {others.length === 0 ? (
            <p className="muted recents-empty">
              {t(favorites.length > 0 ? "welcome.recentEmptyAfterFavorites" : "welcome.recentEmpty")}
            </p>
          ) : (
            <ul>{others.map(row)}</ul>
          )}
        </section>
      </div>
    </main>
  );
}
