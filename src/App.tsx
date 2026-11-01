import { useCallback, useEffect, useRef, useState } from "react";
import { CommitStore } from "./commitStore";
import { DetailPanel } from "./DetailPanel";
import { GraphCanvas } from "./GraphCanvas";
import {
  type CommitDetail,
  type RefInfo,
  type RepoInfo,
  cancelStream,
  closeRepo,
  commitDetail,
  listRefs,
  pickAndOpenRepo,
  streamCommits,
} from "./ipc";
import { Sidebar } from "./Sidebar";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ row: number; nonce: number } | null>(null);

  // Rows live outside React state: chunks of 500 would otherwise trigger a re-render each.
  const store = useRef(new CommitStore());
  const streamId = useRef<number | null>(null);
  const frame = useRef(0);
  const detailSeq = useRef(0);

  const scheduleCount = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setCount(store.current.length);
    });
  }, []);

  const load = useCallback(
    async (info: RepoInfo) => {
      store.current.clear();
      setCount(0);
      setSelected(null);
      setDetail(null);
      setStatus("Loading…");
      setLoading(true);
      const started = performance.now();
      const { streamId: id, done } = streamCommits(info.id, (chunk) => {
        store.current.push(chunk);
        scheduleCount();
      });
      streamId.current = id;
      try {
        const summary = await done;
        setCount(store.current.length);
        const secs = ((performance.now() - started) / 1000).toFixed(2);
        setStatus(
          `${summary.cancelled ? "Cancelled after" : "Loaded"} ${summary.total.toLocaleString()} commits in ${secs}s`,
        );
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
      } finally {
        if (streamId.current === id) {
          streamId.current = null;
          setLoading(false);
        }
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
      setRefs([]);
      void load(info);
      listRefs(info.id).then(setRefs, (e) => setStatus(`Error: ${String(e)}`));
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  };

  const select = useCallback(
    (row: number) => {
      setSelected(row);
      const commit = store.current.rows[row];
      if (!repo || !commit) return;
      const seq = ++detailSeq.current;
      commitDetail(repo.id, commit.oid).then(
        (d) => {
          if (seq !== detailSeq.current) return; // a newer selection superseded this one
          setDetail(d);
          setDetailError(null);
        },
        (e) => {
          if (seq !== detailSeq.current) return;
          setDetail(null);
          setDetailError(String(e));
        },
      );
    },
    [repo],
  );

  const jumpTo = useCallback(
    (oid: string) => {
      const row = store.current.index.get(oid);
      if (row === undefined) {
        setStatus("That commit has not loaded yet");
        return;
      }
      select(row);
      setReveal((r) => ({ row, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [select],
  );

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <main className="app">
      <header className="toolbar">
        <button onClick={open}>Open repository…</button>
        {loading && (
          <button onClick={() => streamId.current !== null && cancelStream(streamId.current)}>
            Cancel
          </button>
        )}
        <span className="repo-name">{repo?.name}</span>
        <span className="status">{status}</span>
      </header>
      <div className="panes">
        <Sidebar refs={refs} onJump={jumpTo} />
        <GraphCanvas
          store={store.current}
          count={count}
          selected={selected}
          onSelect={select}
          reveal={reveal}
        />
        <DetailPanel detail={detail} error={detailError} onJump={jumpTo} />
      </div>
    </main>
  );
}

export default App;
