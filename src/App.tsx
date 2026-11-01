import { useCallback, useEffect, useRef, useState } from "react";
import { ChangesPanel } from "./ChangesPanel";
import { CommitStore } from "./commitStore";
import { DetailPanel } from "./DetailPanel";
import { DiffView } from "./DiffView";
import { GraphCanvas } from "./GraphCanvas";
import {
  type CommitDetail,
  type DiffTarget,
  type FileChange,
  type GitOp,
  type RefInfo,
  type RepoInfo,
  type RepoStatus,
  cancelStream,
  closeRepo,
  commitDetail,
  commitFiles,
  createCommit,
  listRefs,
  newBranch,
  pickAndOpenRepo,
  repoStatus,
  runGitOp,
  stagePaths,
  streamCommits,
  switchRef,
  unstagePaths,
} from "./ipc";
import { Sidebar } from "./Sidebar";
import "./App.css";

type Tab = "commit" | "changes";

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [tab, setTab] = useState<Tab>("commit");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [diffVersion, setDiffVersion] = useState(0);
  const [reveal, setReveal] = useState<{ row: number; nonce: number } | null>(null);

  // Rows live outside React state: chunks of 500 would otherwise trigger a re-render each.
  const store = useRef(new CommitStore());
  const streamId = useRef<number | null>(null);
  const frame = useRef(0);
  const detailSeq = useRef(0);
  const repoRef = useRef<RepoInfo | null>(null);
  repoRef.current = repo;

  const scheduleCount = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setCount(store.current.length);
    });
  }, []);

  const loadStatus = useCallback(async (info: RepoInfo) => {
    try {
      const s = await repoStatus(info.id);
      if (repoRef.current?.id === info.id) setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadGraph = useCallback(
    async (info: RepoInfo) => {
      if (streamId.current !== null) await cancelStream(streamId.current);
      store.current.clear();
      setCount(0);
      setSelected(null);
      setDetail(null);
      setFiles([]);
      setInfo("Loading…");
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
        setInfo(
          `${summary.cancelled ? "Cancelled after" : "Loaded"} ${summary.total.toLocaleString()} commits in ${secs}s`,
        );
      } catch (e) {
        setError(String(e));
      } finally {
        if (streamId.current === id) {
          streamId.current = null;
          setLoading(false);
        }
      }
    },
    [scheduleCount],
  );

  const loadRefs = useCallback(async (info: RepoInfo) => {
    try {
      const r = await listRefs(info.id);
      if (repoRef.current?.id === info.id) setRefs(r);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** "status" after staging; "all" after anything that can move refs or history. */
  const refresh = useCallback(
    async (scope: "status" | "all") => {
      const info = repoRef.current;
      if (!info) return;
      setDiffVersion((v) => v + 1);
      if (scope === "all") {
        await Promise.all([loadStatus(info), loadRefs(info)]);
        void loadGraph(info);
      } else {
        await loadStatus(info);
      }
    },
    [loadGraph, loadRefs, loadStatus],
  );

  /** Runs a mutation, then refreshes even on failure: a conflicted merge still changes state. */
  const act = useCallback(
    async (label: string, scope: "status" | "all", fn: (repoId: number) => Promise<unknown>) => {
      const info = repoRef.current;
      if (!info) return false;
      setBusy(label);
      setProgress("");
      setError(null);
      let ok = true;
      try {
        await fn(info.id);
      } catch (e) {
        ok = false;
        setError(String(e));
      } finally {
        setBusy(null);
        setProgress("");
      }
      await refresh(scope);
      return ok;
    },
    [refresh],
  );

  const gitOp = (label: string, op: GitOp) =>
    act(label, "all", (id) => runGitOp(id, op, setProgress));

  const open = async () => {
    try {
      const picked = await pickAndOpenRepo();
      if (!picked) return;
      if (repo) await closeRepo(repo.id);
      repoRef.current = picked;
      setRepo(picked);
      setRefs([]);
      setStatus(null);
      setDiff(null);
      setError(null);
      void loadGraph(picked);
      void loadRefs(picked);
      void loadStatus(picked);
    } catch (e) {
      setError(String(e));
    }
  };

  const select = useCallback(
    (row: number) => {
      setSelected(row);
      setTab("commit");
      const commit = store.current.rows[row];
      if (!repo || !commit) return;
      const seq = ++detailSeq.current;
      Promise.all([commitDetail(repo.id, commit.oid), commitFiles(repo.id, commit.oid)]).then(
        ([d, f]) => {
          if (seq !== detailSeq.current) return; // a newer selection superseded this one
          setDetail(d);
          setFiles(f);
          setDetailError(null);
        },
        (e) => {
          if (seq !== detailSeq.current) return;
          setDetail(null);
          setFiles([]);
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
        setInfo("That commit has not loaded yet");
        return;
      }
      select(row);
      setReveal((r) => ({ row, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [select],
  );

  // Files change outside the app too; re-read status whenever the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      if (repoRef.current) void loadStatus(repoRef.current);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStatus]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const changeCount = status?.entries.length ?? 0;
  const publish = !!status?.branch && !status.upstream;

  return (
    <main className="app">
      <header className="toolbar">
        <button onClick={open} disabled={!!busy}>
          Open repository…
        </button>
        {loading && (
          <button onClick={() => streamId.current !== null && cancelStream(streamId.current)}>
            Cancel
          </button>
        )}
        {repo && (
          <>
            <span className="repo-name">{repo.name}</span>
            {status && (
              <span className="branch" title={status.upstream ?? "no upstream"}>
                {status.branch ?? "detached HEAD"}
                {status.upstream && ` ↑${status.ahead} ↓${status.behind}`}
              </span>
            )}
            <span className="sep" />
            <button disabled={!!busy} onClick={() => gitOp("Fetching…", { op: "fetch" })}>
              Fetch
            </button>
            <button
              disabled={!!busy || !status?.upstream}
              onClick={() => gitOp("Pulling…", { op: "pull" })}
              title={status?.upstream ? "Fast-forward only" : "No upstream branch"}
            >
              Pull
            </button>
            <button
              disabled={!!busy || !status?.branch}
              onClick={() =>
                gitOp(publish ? "Publishing…" : "Pushing…", { op: "push", set_upstream: publish })
              }
            >
              {publish ? "Publish" : "Push"}
            </button>
          </>
        )}
        <span className={error ? "status error" : "status"} title={error ?? undefined}>
          {busy ? `${busy} ${progress}` : (error ?? info)}
        </span>
        {error && (
          <button className="mini" onClick={() => setError(null)} aria-label="Dismiss error">
            ✕
          </button>
        )}
      </header>
      <div className="panes">
        <Sidebar
          refs={refs}
          busy={!!busy}
          onJump={jumpTo}
          onCheckout={(r) =>
            act("Switching…", "all", (id) =>
              switchRef(id, {
                kind: "branch",
                // `origin/topic` → `topic`: git creates a tracking branch if it is the only match.
                name: r.kind === "remote" ? r.name.split("/").slice(1).join("/") : r.name,
              }),
            )
          }
          onCreateBranch={(name) => act("Creating branch…", "all", (id) => newBranch(id, name, null, true))}
        />
        <div className="center">
          <GraphCanvas
            store={store.current}
            count={count}
            selected={selected}
            onSelect={select}
            reveal={reveal}
          />
          {diff && repo && (
            <DiffView repoId={repo.id} target={diff} version={diffVersion} onClose={() => setDiff(null)} />
          )}
        </div>
        <div className="right">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "commit"} onClick={() => setTab("commit")}>
              Commit
            </button>
            <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
              Changes{changeCount > 0 && <span className="badge">{changeCount}</span>}
            </button>
          </div>
          {tab === "commit" ? (
            <DetailPanel
              detail={detail}
              files={files}
              error={detailError}
              activeDiff={diff}
              onJump={jumpTo}
              onOpenFile={(oid, f) =>
                setDiff({ kind: "commit", oid, path: f.path, orig: f.orig_path })
              }
            />
          ) : (
            <ChangesPanel
              status={status}
              busy={!!busy}
              activeDiff={diff}
              onOpenDiff={setDiff}
              onStage={(paths) =>
                act("Staging…", "status", (id) => stagePaths(id, paths))
              }
              onUnstage={(paths) =>
                act("Unstaging…", "status", (id) => unstagePaths(id, paths))
              }
              onCommit={(message, amend) =>
                act(amend ? "Amending…" : "Committing…", "all", (id) =>
                  createCommit(id, message, amend),
                )
              }
              onContinue={() => gitOp("Continuing…", { op: "continue" })}
              onAbort={() => gitOp("Aborting…", { op: "abort" })}
            />
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
