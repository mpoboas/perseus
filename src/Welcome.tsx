import { Download, FolderOpen, FolderPlus, FolderX, GitBranch, Pencil, Search, Star, X } from "lucide-react";
import type { RecentRepo } from "./ipc";
import { relativeTime } from "./lib/format";
import { repoLabel, splitRecents } from "./lib/repos";
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

/** The mark: a commit graph that bends around a node, in the accent color. */
export function Logo({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Perseus" className="logo">
      <defs>
        <linearGradient id="perseus-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent-hover)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#perseus-g)" />
      <g fill="none" stroke="var(--accent-fg)" strokeWidth="3.5" strokeLinecap="round">
        <path d="M22 14v36" />
        <path d="M22 28c0 8 20 4 20 14" />
      </g>
      <g fill="var(--accent-fg)">
        <circle cx="22" cy="14" r="5" />
        <circle cx="22" cy="50" r="5" />
        <circle cx="42" cy="44" r="5" />
      </g>
    </svg>
  );
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
  const { favorites, others } = splitRecents(recents);

  const row = (r: RecentRepo) => {
    const label = repoLabel(r);
    return (
      <li key={r.path} className={r.exists ? "recent" : "recent missing"}>
        <button
          className="recent-main"
          disabled={busy || !r.exists}
          onClick={() => onOpenRecent(r.path)}
          title={r.exists ? r.path : `${r.path} (folder not found)`}
        >
          {r.exists ? <GitBranch size={16} /> : <FolderX size={16} />}
          <span className="recent-text">
            <strong>{label}</strong>
            <span className="recent-path">{r.alias ? `${r.name} · ${r.path}` : r.path}</span>
          </span>
          <span className="recent-time">{r.exists ? relativeTime(r.last_opened) : "missing"}</span>
        </button>
        <IconButton
          icon={Star}
          label={r.favorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
          size="sm"
          active={r.favorite}
          onClick={() => onToggleFavorite(r.path, !r.favorite)}
        />
        <IconButton icon={Pencil} label={`Rename ${label}`} size="sm" onClick={() => onRename(r.path)} />
        <IconButton icon={X} label={`Remove ${label} from the list`} size="sm" onClick={() => onRemoveRecent(r.path)} />
      </li>
    );
  };

  return (
    <main className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <Logo />
          <h1>Perseus</h1>
          <p>A fast, free visual Git client. Every feature, every repository, no paywall.</p>
          <div className="welcome-actions">
            <Button variant="primary" icon={FolderOpen} disabled={busy} onClick={onOpen}>
              Open repository
              <Shortcut keys="Ctrl+O" />
            </Button>
            <Button icon={Search} onClick={onPalette}>
              Command palette
              <Shortcut keys="Ctrl+K" />
            </Button>
          </div>
          <div className="welcome-actions secondary">
            <Button variant="ghost" icon={Download} disabled={busy} onClick={onClone}>
              Clone a repository
            </Button>
            <Button variant="ghost" icon={FolderPlus} disabled={busy} onClick={onInit}>
              Create a new repository
            </Button>
          </div>
        </div>

        {favorites.length > 0 && (
          <section className="recents" aria-label="Favorite repositories">
            <h2>Favorites</h2>
            <ul>{favorites.map(row)}</ul>
          </section>
        )}

        <section className="recents" aria-label="Recent repositories">
          <h2>Recent</h2>
          {others.length === 0 ? (
            <p className="muted recents-empty">
              {favorites.length > 0
                ? "Other repositories you open show up here."
                : "Repositories you open show up here, so getting back to them is one click."}
            </p>
          ) : (
            <ul>{others.map(row)}</ul>
          )}
        </section>
      </div>
    </main>
  );
}
