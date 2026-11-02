import { FolderOpen, FolderX, GitBranch, Search, X } from "lucide-react";
import type { RecentRepo } from "./ipc";
import { relativeTime } from "./lib/format";
import { Button, IconButton, Shortcut } from "./ui";

interface Props {
  recents: RecentRepo[];
  busy: boolean;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onPalette: () => void;
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

export function Welcome({ recents, busy, onOpen, onOpenRecent, onRemoveRecent, onPalette }: Props) {
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
        </div>

        <section className="recents" aria-label="Recent repositories">
          <h2>Recent</h2>
          {recents.length === 0 ? (
            <p className="muted recents-empty">
              Repositories you open show up here, so getting back to them is one click.
            </p>
          ) : (
            <ul>
              {recents.map((r) => (
                <li key={r.path} className={r.exists ? "recent" : "recent missing"}>
                  <button
                    className="recent-main"
                    disabled={busy || !r.exists}
                    onClick={() => onOpenRecent(r.path)}
                    title={r.exists ? r.path : `${r.path} (folder not found)`}
                  >
                    {r.exists ? <GitBranch size={16} /> : <FolderX size={16} />}
                    <span className="recent-text">
                      <strong>{r.name}</strong>
                      <span className="recent-path">{r.path}</span>
                    </span>
                    <span className="recent-time">{r.exists ? relativeTime(r.last_opened) : "missing"}</span>
                  </button>
                  <IconButton
                    icon={X}
                    label={`Remove ${r.name} from recent`}
                    size="sm"
                    onClick={() => onRemoveRecent(r.path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
