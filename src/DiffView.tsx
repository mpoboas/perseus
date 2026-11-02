import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, TriangleAlert, X } from "lucide-react";
import { type DiffTarget, type Patch, fetchPatch } from "./ipc";
import { type DiffRow, parseDiff } from "./lib/diffParse";
import { shortSha, splitPath } from "./lib/format";
import { Badge, EmptyState, IconButton, Skeleton } from "./ui";

const LINE_H = 20;
const OVERSCAN = 24;
const CHAR_W = 7.3; // monospace 12px; only used to size the horizontal scroll extent

interface Props {
  repoId: number;
  target: DiffTarget;
  /** Bumps when the underlying files may have changed (e.g. after staging). */
  version: number;
  onClose: () => void;
}

/** Header lines add noise; keep only the ones that explain something about the file. */
const KEEP_META = /^(rename |similarity|dissimilarity|new file|deleted file|old mode|new mode|copy |Binary |GIT binary|\\)/;

function visibleRows(rows: DiffRow[]): DiffRow[] {
  return rows.filter((r) => r.kind !== "meta" || KEEP_META.test(r.text));
}

function sideLabel(t: DiffTarget): string {
  if (t.kind === "commit") return `at ${shortSha(t.oid)}`;
  return t.side === "staged" ? "staged" : t.side === "untracked" ? "untracked" : "working tree";
}

export function DiffView({ repoId, target, version, onClose }: Props) {
  const [patch, setPatch] = useState<Patch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(300);
  const box = useRef<HTMLDivElement>(null);

  const key = JSON.stringify(target);
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    setLoading(true);
    fetchPatch(repoId, target, ctl.signal).then(
      (p) => {
        setPatch(p);
        setLoading(false);
        box.current?.scrollTo({ top: 0, left: 0 });
      },
      (e) => {
        if (!ctl.signal.aborted) {
          setPatch(null);
          setError(String(e));
          setLoading(false);
        }
      },
    );
    return () => ctl.abort();
    // `key` stands in for `target`, which is a fresh object on every render.
  }, [repoId, key, version]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [loading]);

  const parsed = useMemo(() => (patch ? parseDiff(patch.text) : null), [patch]);
  const rows = useMemo(() => (parsed ? visibleRows(parsed.rows) : []), [parsed]);
  const digits = useMemo(() => {
    let max = 0;
    for (const r of rows) max = Math.max(max, r.oldNo ?? 0, r.newNo ?? 0);
    return Math.max(2, String(max).length);
  }, [rows]);

  const gutterW = digits * 8 + 14;
  const first = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);
  const { dir, name } = splitPath(target.path);
  const contentW = gutterW * 2 + 24 + (parsed?.widest ?? 0) * CHAR_W + 24;

  return (
    <section className="diff-view" aria-label={`Changes in ${target.path}`}>
      <header className="diff-head">
        <FileDiff size={15} className="diff-icon" />
        <div className="diff-title" title={target.path}>
          <span className="file-dir">{dir}</span>
          <strong>{name}</strong>
        </div>
        <Badge>{sideLabel(target)}</Badge>
        {parsed && (parsed.additions > 0 || parsed.deletions > 0) && (
          <span className="stats">
            <span className="plus">+{parsed.additions}</span>
            <span className="minus">−{parsed.deletions}</span>
          </span>
        )}
        {patch?.truncated && (
          <Badge tone="warn" title="The patch was cut off at the size limit">
            <TriangleAlert size={11} /> &nbsp;Truncated at 4 MiB
          </Badge>
        )}
        <span className="grow" />
        <IconButton icon={X} label="Close diff" size="sm" shortcut="Esc" onClick={onClose} />
      </header>

      {error ? (
        <EmptyState icon={TriangleAlert} title="Could not load this diff" hint={error} />
      ) : loading && !patch ? (
        <div className="diff-skeleton">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} width={`${25 + ((i * 29) % 60)}%`} height={11} />
          ))}
        </div>
      ) : parsed?.binary ? (
        <EmptyState icon={FileDiff} title="Binary file" hint="There is no text preview for this file." />
      ) : rows.length === 0 ? (
        <EmptyState icon={FileDiff} title="No textual changes" hint="The file mode or whitespace may have changed." />
      ) : (
        <div ref={box} className="diff-body" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div className="diff-canvas" style={{ height: rows.length * LINE_H, minWidth: contentW }}>
            {rows.slice(first, last).map((r, i) => (
              <div
                key={first + i}
                className={`diff-line ${r.kind}`}
                style={{ top: (first + i) * LINE_H, height: LINE_H }}
              >
                <span className="gutter" style={{ width: gutterW }}>
                  {r.oldNo ?? ""}
                </span>
                <span className="gutter" style={{ width: gutterW, left: gutterW }}>
                  {r.newNo ?? ""}
                </span>
                <span className="marker">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                <span className="code">{r.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
