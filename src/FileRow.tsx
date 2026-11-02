import type { ReactNode } from "react";
import type { LineStats } from "./ipc";
import { splitPath } from "./lib/format";

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: "Added", cls: "add" },
  M: { label: "Modified", cls: "mod" },
  D: { label: "Deleted", cls: "del" },
  R: { label: "Renamed", cls: "ren" },
  C: { label: "Copied", cls: "ren" },
  T: { label: "Type changed", cls: "other" },
  U: { label: "Conflicted", cls: "conflict" },
  "?": { label: "Untracked", cls: "add" },
};

/** A small colored square with the change letter; the color is the quick-scan signal. */
export function StatusIcon({ code }: { code: string }) {
  const s = STATUS[code] ?? { label: code, cls: "other" };
  return (
    <span className={`st-icon st-${s.cls}`} title={s.label} aria-label={s.label}>
      {code}
    </span>
  );
}

export function Stats({ stats }: { stats: LineStats | null | undefined }) {
  if (!stats) return null;
  if (stats.additions === null || stats.deletions === null) return <span className="stats binary">binary</span>;
  return (
    <span className="stats">
      {stats.additions > 0 && <span className="plus">+{stats.additions}</span>}
      {stats.deletions > 0 && <span className="minus">−{stats.deletions}</span>}
    </span>
  );
}

interface Props {
  path: string;
  origPath?: string | null;
  code: string;
  stats?: LineStats | null;
  active?: boolean;
  /** Show only the file name (the tree view prints folders separately). */
  nameOnly?: boolean;
  depth?: number;
  onOpen: () => void;
  /** Leading control (a checkbox in the Changes list). */
  leading?: ReactNode;
  /** Trailing control (hover actions). */
  trailing?: ReactNode;
}

export function FileRow({ path, origPath, code, stats, active, nameOnly, depth = 0, onOpen, leading, trailing }: Props) {
  const { dir, name } = splitPath(path);
  return (
    <li className={active ? "file-row active" : "file-row"} style={{ paddingLeft: 8 + depth * 14 }}>
      {leading}
      <button className="file-main" onClick={onOpen} title={origPath ? `${origPath} → ${path}` : path}>
        <StatusIcon code={code} />
        <span className="file-name">
          {origPath && <span className="file-dir">{origPath} → </span>}
          {!nameOnly && dir && <span className="file-dir">{dir}</span>}
          <span className="file-base">{name}</span>
        </span>
        <Stats stats={stats} />
      </button>
      {trailing}
    </li>
  );
}
