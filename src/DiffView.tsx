import { useEffect, useMemo, useRef, useState } from "react";
import { type DiffTarget, type Patch, fetchPatch } from "./ipc";

const LINE_H = 18;
const OVERSCAN = 20;
const CHAR_W = 7.3; // monospace 12px; only used to size the horizontal scroll extent

interface Props {
  repoId: number;
  target: DiffTarget;
  /** Bumps when the underlying files may have changed (e.g. after staging). */
  version: number;
  onClose: () => void;
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (/^(diff |index |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary )/.test(line))
    return "meta";
  return "ctx";
}

function describe(t: DiffTarget): string {
  if (t.kind === "commit") return `${t.path} @ ${t.oid.slice(0, 7)}`;
  return `${t.path} (${t.side})`;
}

export function DiffView({ repoId, target, version, onClose }: Props) {
  const [patch, setPatch] = useState<Patch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(300);
  const box = useRef<HTMLDivElement>(null);

  const key = JSON.stringify(target);
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    fetchPatch(repoId, target, ctl.signal).then(
      (p) => {
        setPatch(p);
        box.current?.scrollTo({ top: 0, left: 0 });
      },
      (e) => {
        if (!ctl.signal.aborted) {
          setPatch(null);
          setError(String(e));
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
  }, []);

  const lines = useMemo(() => (patch ? patch.text.replace(/\n$/, "").split("\n") : []), [patch]);
  const widest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);

  const first = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);

  return (
    <section className="diff-view">
      <header className="diff-head">
        <strong title={describe(target)}>{describe(target)}</strong>
        {patch?.truncated && <span className="warn">Truncated: patch exceeds 4 MiB</span>}
        <button className="mini" onClick={onClose} aria-label="Close diff">
          ✕
        </button>
      </header>
      {error ? (
        <div className="diff-empty error">{error}</div>
      ) : patch && lines.length === 1 && lines[0] === "" ? (
        <div className="diff-empty">No textual changes</div>
      ) : (
        <div ref={box} className="diff-body" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: lines.length * LINE_H, minWidth: widest * CHAR_W + 24, position: "relative" }}>
            {lines.slice(first, last).map((l, i) => (
              <div
                key={first + i}
                className={`diff-line ${lineClass(l)}`}
                style={{ top: (first + i) * LINE_H, height: LINE_H }}
              >
                {l || " "}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
