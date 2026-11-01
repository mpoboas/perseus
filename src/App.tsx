import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CommitRow,
  type RepoInfo,
  cancelStream,
  closeRepo,
  pickAndOpenRepo,
  streamCommits,
} from "./ipc";
import "./App.css";

const ROW_HEIGHT = 22;
const OVERSCAN = 10;

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);

  // Rows live outside React state: chunks of 500 would otherwise trigger a re-render each.
  const rows = useRef<CommitRow[]>([]);
  const streamId = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  const scheduleCount = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setCount(rows.current.length);
    });
  }, []);

  const load = useCallback(
    async (info: RepoInfo) => {
      rows.current = [];
      setCount(0);
      setStatus("Loading…");
      const started = performance.now();
      const { streamId: id, done } = streamCommits(info.id, (chunk) => {
        for (const r of chunk) rows.current.push(r);
        scheduleCount();
      });
      streamId.current = id;
      try {
        const summary = await done;
        setCount(rows.current.length);
        const secs = ((performance.now() - started) / 1000).toFixed(2);
        setStatus(
          `${summary.cancelled ? "Cancelled after" : "Loaded"} ${summary.total.toLocaleString()} commits in ${secs}s`,
        );
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
      } finally {
        if (streamId.current === id) streamId.current = null;
      }
    },
    [scheduleCount],
  );

  const open = async () => {
    try {
      const info = await pickAndOpenRepo();
      if (!info) return;
      if (streamId.current !== null) await cancelStream(streamId.current);
      if (repo) await closeRepo(repo.id);
      setRepo(info);
      void load(info);
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.current.slice(first, last);

  return (
    <main className="app">
      <header className="toolbar">
        <button onClick={open}>Open repository…</button>
        {streamId.current !== null && (
          <button onClick={() => cancelStream(streamId.current!)}>Cancel</button>
        )}
        <span className="repo-name">{repo?.name}</span>
        <span className="status">{status}</span>
      </header>
      <div
        ref={listRef}
        className="commit-list"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: count * ROW_HEIGHT, position: "relative" }}>
          {visible.map((r, i) => (
            <div
              key={r.oid}
              className="commit-row"
              style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <code>{r.oid.slice(0, 7)}</code>
              {r.refs.map((ref) => (
                <span key={ref} className="ref">
                  {ref}
                </span>
              ))}
              <span className="summary">{r.summary}</span>
              <span className="author">{r.author}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export default App;
