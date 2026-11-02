import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, MinusCircle, PlusCircle, Trash2, TriangleAlert, X } from "lucide-react";
import { type DiffTarget, type HunkPick, type Patch, type PatchMode, fetchPatch } from "./ipc";
import { type DiffRow, parseDiff } from "./lib/diffParse";
import { shortSha, splitPath } from "./lib/format";
import { Badge, Button, EmptyState, IconButton, Skeleton } from "./ui";

const LINE_H = 20;
const OVERSCAN = 24;
const CHAR_W = 7.3; // monospace 12px; only used to size the horizontal scroll extent
const CHECK_W = 24;

interface Props {
  repoId: number;
  target: DiffTarget;
  /** Bumps when the underlying files may have changed (e.g. after staging). */
  version: number;
  onClose: () => void;
  /** Stage, unstage or discard hunks or lines of the working-tree diff (asks first for discard). */
  onPatch?: (path: string, mode: PatchMode, picks: HunkPick[], what: string) => void;
  busy?: boolean;
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

const key = (hunk: number, idx: number) => `${hunk}:${idx}`;

export function DiffView({ repoId, target, version, onClose, onPatch, busy }: Props) {
  const [patch, setPatch] = useState<Patch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(300);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);

  const targetKey = JSON.stringify(target);
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    setLoading(true);
    fetchPatch(repoId, target, ctl.signal).then(
      (p) => {
        setPatch(p);
        setLoading(false);
        setPicked(new Set());
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
    // `targetKey` stands in for `target`, which is a fresh object on every render.
  }, [repoId, targetKey, version]);

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

  // Parts of a diff can be staged only for tracked files in the working tree, and only when the
  // patch was not cut off (a truncated patch would not match what the backend sees).
  const side = target.kind === "work" ? target.side : null;
  const stageable = !!onPatch && (side === "unstaged" || side === "staged") && !patch?.truncated;
  const checkW = stageable ? CHECK_W : 0;
  const gutterW = digits * 8 + 14;
  const first = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);
  const { dir, name } = splitPath(target.path);
  const contentW = checkW + gutterW * 2 + 24 + (parsed?.widest ?? 0) * CHAR_W + 24;

  const picksFor = (sel: Set<string>): HunkPick[] => {
    if (!parsed) return [];
    const byHunk = new Map<number, number[]>();
    for (const k of sel) {
      const [h, i] = k.split(":").map(Number);
      byHunk.set(h, [...(byHunk.get(h) ?? []), i]);
    }
    return [...byHunk].map(([h, lines]) => ({
      hunk: h,
      header: parsed.hunks[h].header,
      checksum: parsed.hunks[h].checksum,
      lines: lines.sort((a, b) => a - b),
    }));
  };

  const hunkPick = (h: number): HunkPick[] => [
    { hunk: h, header: parsed!.hunks[h].header, checksum: parsed!.hunks[h].checksum, lines: null },
  ];

  const apply = (mode: PatchMode, picks: HunkPick[], what: string) => onPatch?.(target.path, mode, picks, what);
  const primary: PatchMode = side === "staged" ? "unstage" : "stage";
  const primaryLabel = side === "staged" ? "Unstage" : "Stage";

  const toggle = (k: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(k)) next.add(k);
      return next;
    });

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
        {stageable && picked.size > 0 && (
          <div className="pick-bar" role="group" aria-label="Selected lines">
            <span className="muted small">
              {picked.size} line{picked.size === 1 ? "" : "s"} selected
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => apply(primary, picksFor(picked), `${picked.size} line${picked.size === 1 ? "" : "s"}`)}
            >
              {primaryLabel} lines
            </Button>
            {side === "unstaged" && (
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => apply("discard", picksFor(picked), `${picked.size} line${picked.size === 1 ? "" : "s"}`)}
              >
                Discard lines
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </div>
        )}
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
            {rows.slice(first, last).map((r, i) => {
              const selectable = stageable && (r.kind === "add" || r.kind === "del") && r.hunk !== undefined;
              const k = selectable ? key(r.hunk!, r.idx!) : "";
              return (
                <div
                  key={first + i}
                  className={`diff-line ${r.kind}${selectable && picked.has(k) ? " picked" : ""}`}
                  style={{ top: (first + i) * LINE_H, height: LINE_H }}
                >
                  {stageable && (
                    <span className="gutter check-cell" style={{ width: checkW, left: 0 }}>
                      {selectable && (
                        <input
                          type="checkbox"
                          className="line-check"
                          aria-label={`Select ${r.kind === "add" ? "added" : "removed"} line ${r.newNo ?? r.oldNo}`}
                          checked={picked.has(k)}
                          onChange={() => toggle(k)}
                        />
                      )}
                    </span>
                  )}
                  <span className="gutter" style={{ width: gutterW, left: checkW }}>
                    {r.oldNo ?? ""}
                  </span>
                  <span className="gutter" style={{ width: gutterW, left: checkW + gutterW }}>
                    {r.newNo ?? ""}
                  </span>
                  <span className="marker">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                  <span className="code">{r.text || " "}</span>
                  {stageable && r.kind === "hunk" && r.hunk !== undefined && (
                    <span className="hunk-actions">
                      <button
                        className="hunk-btn"
                        disabled={busy}
                        onClick={() => apply(primary, hunkPick(r.hunk!), "this hunk")}
                      >
                        {side === "staged" ? <MinusCircle size={12} /> : <PlusCircle size={12} />}
                        {primaryLabel} hunk
                      </button>
                      {side === "unstaged" && (
                        <button
                          className="hunk-btn danger"
                          disabled={busy}
                          onClick={() => apply("discard", hunkPick(r.hunk!), "this hunk")}
                        >
                          <Trash2 size={12} />
                          Discard hunk
                        </button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
