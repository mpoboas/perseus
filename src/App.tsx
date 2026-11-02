import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FolderOpen,
  Terminal,
  Code2,
  GitBranch,
  GitBranchPlus,
  History,
  Archive,
  Cable,
  Download,
  FolderPlus,
  Keyboard,
  Search,
  Settings,
  Moon,
  PanelLeft,
  RefreshCw,
  Sun,
  Tag,
  User,
  Users,
  X,
  Redo2,
  Undo2,
} from "lucide-react";
import { type Endpoint, type GraphAction, type Head, dropActions, menuActions } from "./actions";
import { ChangesPanel } from "./ChangesPanel";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { CommitStore } from "./commitStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileHistoryDialog } from "./FileHistoryDialog";
import { DetailPanel } from "./DetailPanel";
import { DiffView } from "./DiffView";
import { GraphCanvas, type WipSummary } from "./GraphCanvas";
import type { Subject } from "./graphLayout";
import {
  type CommitDetail,
  type DiffTarget,
  type FileChange,
  type ChangeSet,
  type GitOp,
  type CiState,
  type GitAction,
  type GraphFilter,
  type HostingInfo,
  type Issue,
  type MergeMethod,
  type LargeFile,
  type PullRequest,
  type Question,
  type Signature,
  type Prediction,
  type Resolution,
  type TodoItem,
  type HunkPick,
  type PatchSource,
  type PatchMode,
  type ProfilesSnapshot,
  type PullMode,
  type RecentRepo,
  type RefInfo,
  type RemoteInfo,
  type RepoInfo,
  type RepoStatus,
  type StashEntry,
  cancelGitOp,
  answerAskpass,
  addWorktree,
  applyPatchFile,
  cloneRepo,
  checkoutPullRequest,
  cancelStream,
  ciState,
  closeRepo,
  createPullRequest,
  hostingInfo,
  listIssues,
  listPullRequests,
  mergePullRequest,
  openInBrowser,
  initRepo,
  interactiveRebase,
  openIn,
  predictMerge,
  predictPick,
  resolveConflict,
  commitDetail,
  commitSignature,
  commitFiles,
  commitTemplate,
  createCommit,
  exportPatch,
  gitAction,
  undoRestore,
  undoSnapshot,
  type UndoSnapshot,
  listProfiles,
  listRecentRepos,
  listRefs,
  listRemotes,
  largeStagedFiles,
  lfsTrack,
  listStashes,
  newBranch,
  newOpId,
  openRecentRepo,
  pickAndOpenRepo,
  removeRecentRepo,
  repoStatus,
  runGitOp,
  setActiveProfile,
  stagePaths,
  streamCommits,
  switchRef,
  unstagePaths,
  openNestedRepo,
  removeWorktree,
  unwatchRepo,
  updateSubmodules,
  watchAskpass,
  watchRepo,
} from "./ipc";
import { readPref, usePref, writePref } from "./lib/prefs";
import { useThemePref } from "./lib/theme";
import { AskpassDialog } from "./AskpassDialog";
import { ExtrasSections } from "./ExtrasSections";
import { type PageId, SettingsPage } from "./settings/SettingsPage";
import { KEYS, LARGE_FILE_DEFAULT, repoKey } from "./settings/keys";
import { CloneDialog } from "./CloneDialog";
import { CreatePrDialog } from "./CreatePrDialog";
import { ConflictDialog } from "./ConflictDialog";
import { RebaseDialog } from "./RebaseDialog";
import { NewBranchDialog } from "./NewBranchDialog";
import { RepoTabs, type Tab as RepoTab } from "./RepoTabs";
import { SearchDialog } from "./SearchDialog";
import { RemotesDialog } from "./RemotesDialog";
import { StashDialog } from "./StashDialog";
import { profileFor, type ProfileRule } from "./lib/profileRules";
import { ProfilesDialog, RULES_KEY } from "./ProfilesDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { setAvatarRepo } from "./lib/avatars";
import { undoName } from "./lib/format";
import { layoutMenu } from "./menuLayout";
import { Badge, Menu, type MenuItem, Splitter, useToast } from "./ui";
import { Welcome } from "./Welcome";

type Tab = "commit" | "changes";

interface ActOptions {
  /** Toast shown when the action succeeds (quiet by default). */
  done?: string;
  /** Title of the error toast. */
  fail?: string;
  /** The action edits tracked files (staging, discarding, stashing), so undo records them too. */
  files?: boolean;
}

/** Actions that change files or the index, so their undo needs the file state. */
const FILE_ACTIONS = new Set(["discard", "patch", "stash_push", "stash_apply", "stash_pop", "stash_drop"]);

/** One step of the undo history: the branches before and after an action. */
interface UndoEntry {
  label: string;
  before: UndoSnapshot;
  after: UndoSnapshot;
  /** Moving back keeps the changes staged (commits and amends) instead of restoring the files. */
  soft: boolean;
}

const lastOf = <T,>(list: T[]): T | undefined => list[list.length - 1];

const sameSnapshot = (a: UndoSnapshot, b: UndoSnapshot) => JSON.stringify(a) === JSON.stringify(b);

function App() {
  const toast = useToast();
  const [theme, setTheme] = useThemePref();

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [cancellable, setCancellable] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [signature, setSignature] = useState<Signature | null>(null);
  const autoProfileFor = useRef<number | null>(null);
  const [hosting, setHosting] = useState<HostingInfo | null>(null);
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [ci, setCi] = useState<Record<string, CiState>>({});
  const [hostingError, setHostingError] = useState<string | null>(null);
  const [prBranch, setPrBranch] = useState<string | null>(null);
  const [resolvePath, setResolvePath] = useState<string | null>(null);
  const [rebaseBase, setRebaseBase] = useState<{ oid: string; label: string } | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [filter, setFilter] = useState<GraphFilter>({ hidden: [], solo: [] });
  const [tabs, setTabs] = usePref<RepoTab[]>("session.tabs", []);
  const restored = useRef(false);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState("");
  const [lastError, setLastError] = useState<{ title: string; detail: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [tab, setTab] = useState<Tab>("commit");
  const [selected, setSelected] = useState<number | "wip" | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [diffVersion, setDiffVersion] = useState(0);
  const [reveal, setReveal] = useState<{ row: number; nonce: number } | null>(null);
  const [profiles, setProfiles] = useState<ProfilesSnapshot | null>(null);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<PageId>("general");
  const openSettings = (page: PageId = "general") => {
    setSettingsPage(page);
    setSettingsOpen(true);
  };
  const [largeFiles, setLargeFiles] = useState<LargeFile[]>([]);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: GraphAction[] } | null>(null);
  const [confirm, setConfirm] = useState<GraphAction[] | null>(null);

  const [pullMode, setPullMode] = usePref<PullMode>("git.pullMode", "ff_only");
  const [sidebarOpen, setSidebarOpen] = usePref("layout.sidebarOpen", true);
  const [sidebarW, setSidebarW] = usePref("layout.sidebarW", 248);
  const [rightW, setRightW] = usePref("layout.rightW", 380);
  const [diffH, setDiffH] = usePref("layout.diffH", 320);
  const [authorW, setAuthorW] = usePref("layout.authorW", 170);
  const [dateW, setDateW] = usePref("layout.dateW", 150);
  const [refsW, setRefsW] = usePref("layout.refsW", 190);
  const [dateStyle] = usePref<"absolute" | "relative">(KEYS.dateStyle, "absolute");
  const [showRefs] = usePref<boolean>(KEYS.graphRefs, true);
  const [showAuthor] = usePref<boolean>(KEYS.graphAuthor, true);
  const [showDate] = usePref<boolean>(KEYS.graphDate, true);
  const [ghostBranch] = usePref<boolean>(KEYS.graphGhost, true);
  const [rowBands] = usePref<boolean>(KEYS.graphBands, true);
  const [toolbarLabels] = usePref<boolean>(KEYS.toolbarLabels, true);
  const [autoFetchMinutes] = usePref<number>(KEYS.autoFetch, 0);
  const [autoPrune] = usePref<boolean>(KEYS.autoPrune, false);

  // Rows live outside React state: chunks of 500 would otherwise trigger a re-render each.
  const store = useRef(new CommitStore());
  const streamId = useRef<number | null>(null);
  const frame = useRef(0);
  const detailSeq = useRef(0);
  const wasInOperation = useRef(false);
  const selectedRef = useRef<number | "wip" | null>(null);
  /** Commit to re-select once a reload finishes (row numbers change when history reloads). */
  const keepOid = useRef<string | null>(null);
  /** The selection at the moment a reload started, to tell whether the user changed it meanwhile. */
  const keepSel = useRef<number | "wip" | null>(null);
  const watchId = useRef<number | null>(null);
  const undoStacks = useRef(new Map<string, { undo: UndoEntry[]; redo: UndoEntry[] }>());
  const [, setUndoTick] = useState(0);
  const opIdRef = useRef<number | null>(null);
  const filterRef = useRef<GraphFilter>({ hidden: [], solo: [] });
  const busyRef = useRef<string | null>(null);
  const lastActEnd = useRef(0);
  const adoptedAt = useRef(0);
  const pendingChange = useRef<ChangeSet>({ refs: false, worktree: false });
  const changeTimer = useRef(0);
  const onChangedRef = useRef<(c: ChangeSet) => void>(() => undefined);
  const repoRef = useRef<RepoInfo | null>(null);
  repoRef.current = repo;
  const [skipHooksDefault] = usePref<boolean>(repoKey(repo?.path ?? "-", "skipHooks"), false);
  const fetchOp = (): GitOp => ({ op: "fetch", prune: autoPrune });
  useEffect(() => setAvatarRepo(repo?.id ?? null), [repo?.id]);
  selectedRef.current = selected;
  busyRef.current = busy;

  const report = useCallback((title: string, e: unknown) => {
    const detail = String(e);
    setLastError({ title, detail });
    toast.error(title, detail);
  }, [toast]);

  const scheduleCount = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setCount(store.current.length);
    });
  }, []);

  const reloadRecents = useCallback(async () => {
    try {
      setRecents(await listRecentRepos());
    } catch {
      /* the welcome list is a nicety; a failure here must not block anything */
    }
  }, []);

  const loadStatus = useCallback(
    async (info: RepoInfo) => {
      try {
        const s = await repoStatus(info.id);
        if (repoRef.current?.id !== info.id) return;
        // A merge/rebase/cherry-pick that stopped on conflicts needs the Changes tab: that is
        // where Abort and Continue live. Only jump on the transition, not on every refresh.
        if (s.operation && !wasInOperation.current) setTab("changes");
        wasInOperation.current = !!s.operation;
        setStatus(s);
      } catch (e) {
        report("Could not read the working tree", e);
      }
    },
    [report],
  );

  /**
   * Streams the history into the graph. A `silent` reload (after a commit, fetch or an external
   * change) fills a second store and swaps it in when done, so the graph never blanks or flickers
   * and keeps its scroll position.
   */
  const loadGraph = useCallback(
    async (info: RepoInfo, silent = false) => {
      if (streamId.current !== null) await cancelStream(streamId.current);
      const target = silent ? new CommitStore() : store.current;
      if (!silent) {
        store.current.clear();
        setCount(0);
        if (!keepOid.current) {
          setDetail(null);
          setFiles([]);
        }
        setLoaded("");
        setLoading(true);
      }
      const started = performance.now();
      const { streamId: id, done } = streamCommits(
        info.id,
        (chunk) => {
          target.push(chunk);
          if (!silent) scheduleCount();
        },
        filterRef.current,
      );
      streamId.current = id;
      try {
        const summary = await done;
        // A newer load took over while this one was running: it owns the state now, and this
        // result (built from an older store) must not overwrite it.
        if (streamId.current !== id) return;
        if (silent && summary.cancelled) return;
        if (silent) store.current = target;
        setCount(target.length);
        // Put the selection back on the same commit, unless the user picked another one while
        // the history was reloading in the background.
        if (keepOid.current && selectedRef.current === keepSel.current) {
          const row = target.index.get(keepOid.current);
          setSelected(row ?? null);
        }
        const secs = ((performance.now() - started) / 1000).toFixed(2);
        setLoaded(
          `${summary.total.toLocaleString()} commits · ${secs}s${summary.cancelled ? " (stopped)" : ""}`,
        );
      } catch (e) {
        report("Could not read the history", e);
      } finally {
        if (streamId.current === id) {
          keepOid.current = null;
          streamId.current = null;
          setLoading(false);
        }
      }
    },
    [report, scheduleCount],
  );

  const loadRefs = useCallback(
    async (info: RepoInfo) => {
      try {
        const [r, st, rm] = await Promise.all([
          listRefs(info.id),
          listStashes(info.id).catch(() => [] as StashEntry[]),
          listRemotes(info.id).catch(() => [] as RemoteInfo[]),
        ]);
        if (repoRef.current?.id === info.id) {
          setRefs(r);
          setStashes(st);
          setRemotes(rm);
        }
      } catch (e) {
        report("Could not list branches", e);
      }
    },
    [report],
  );

  /** Pull requests, issues and their checks. Quiet on failure: a repository without a provider is normal. */
  const loadHosting = useCallback(async (info: RepoInfo) => {
    try {
      const h = await hostingInfo(info.id);
      if (repoRef.current?.id !== info.id) return;
      setHosting(h);
      setHostingError(null);
      if (!h) {
        setPulls([]);
        setIssues([]);
        return;
      }
      const [p, i] = await Promise.allSettled([listPullRequests(info.id, "open"), listIssues(info.id)]);
      if (repoRef.current?.id !== info.id) return;
      setPulls(p.status === "fulfilled" ? p.value : []);
      setIssues(i.status === "fulfilled" ? i.value : []);
      const failure = [p, i].find((r) => r.status === "rejected");
      setHostingError(failure && failure.status === "rejected" ? String(failure.reason) : null);
      if (p.status === "fulfilled") {
        // Check states one request each, a few at a time, for the pull requests shown first.
        const shas = [...new Set(p.value.slice(0, 15).map((x) => x.head_sha).filter(Boolean))];
        for (let n = 0; n < shas.length; n += 4) {
          const batch = shas.slice(n, n + 4);
          const states = await Promise.allSettled(batch.map((sha) => ciState(info.id, sha)));
          if (repoRef.current?.id !== info.id) return;
          setCi((c) => ({
            ...c,
            ...Object.fromEntries(batch.flatMap((sha, k) => (states[k].status === "fulfilled" ? [[sha, states[k].value]] : []))),
          }));
        }
      }
    } catch {
      /* no provider, or offline */
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
        // A reload re-numbers rows: remember the commit and find its new row when loading ends.
        const sel = selectedRef.current;
        keepOid.current = typeof sel === "number" ? (store.current.rows[sel]?.oid ?? null) : null;
        keepSel.current = sel;
        void loadGraph(info, true);
      } else {
        await loadStatus(info);
      }
    },
    [loadGraph, loadRefs, loadStatus],
  );

  /** Runs a mutation, then refreshes even on failure: a conflicted merge still changes state. */
  const act = useCallback(
    async (
      label: string,
      scope: "status" | "all",
      fn: (repoId: number) => Promise<unknown>,
      opts: ActOptions = {},
    ) => {
      const info = repoRef.current;
      if (!info) return false;
      setBusy(label);
      setProgress("");
      const files = !!opts.files;
      const before = scope === "all" || files ? await undoSnapshot(info.id, files).catch(() => null) : null;
      let ok = true;
      try {
        await fn(info.id);
      } catch (e) {
        ok = false;
        report(opts.fail ?? "That did not work", e);
      } finally {
        setBusy(null);
        setProgress("");
      }
      if (before) {
        // Whatever changed local branches, even a failed or half-finished action, can be undone.
        const after = await undoSnapshot(info.id, files).catch(() => null);
        if (after && !sameSnapshot(before, after)) {
          const stack = undoStack(info.path);
          stack.undo.push({ label, before, after, soft: /^(Committing|Amending)/.test(label) });
          stack.redo = [];
          setUndoTick((n) => n + 1);
        }
      }
      await refresh(scope);
      // The watcher also sees our own writes; the refresh above already covered them.
      lastActEnd.current = Date.now();
      // Announce success once the view shows it, not before.
      if (ok && opts.done) toast.success(opts.done);
      return ok;
    },
    [refresh, report, toast],
  );

  /** Undo and redo history of the open repository (kept in memory; it ends when the app closes). */
  const undoStack = (path: string) => {
    let s = undoStacks.current.get(path);
    if (!s) undoStacks.current.set(path, (s = { undo: [], redo: [] }));
    return s;
  };

  const stepHistory = async (direction: "undo" | "redo") => {
    const info = repoRef.current;
    if (!info || busyRef.current) return;
    const stack = undoStack(info.path);
    const from = direction === "undo" ? stack.undo : stack.redo;
    const entry = from.pop();
    if (!entry) return;
    setBusy(direction === "undo" ? "Undoing…" : "Redoing…");
    try {
      const [target, left] = direction === "undo" ? [entry.before, entry.after] : [entry.after, entry.before];
      await undoRestore(info.id, target, entry.soft, left);
      (direction === "undo" ? stack.redo : stack.undo).push(entry);
      toast.success(`${direction === "undo" ? "Undid" : "Redid"} ${undoName(entry.label)}`);
    } catch (e) {
      from.push(entry);
      report(direction === "undo" ? "Could not undo" : "Could not redo", e);
    } finally {
      setBusy(null);
      setUndoTick((n) => n + 1);
    }
    await refresh("all");
    lastActEnd.current = Date.now();
  };

  const gitOp = (label: string, op: GitOp, opts?: ActOptions) =>
    act(
      label,
      "all",
      async (id) => {
        const opId = newOpId();
        opIdRef.current = opId;
        setCancellable(true);
        try {
          await runGitOp(id, op, setProgress, opId);
        } finally {
          opIdRef.current = null;
          setCancellable(false);
        }
      },
      opts,
    );

  const cancelRunning = () => {
    if (opIdRef.current !== null) void cancelGitOp(opIdRef.current);
  };

  const doAction = (label: string, action: GitAction, opts?: ActOptions) =>
    act(label, "all", (id) => gitAction(id, action), { ...opts, files: opts?.files ?? FILE_ACTIONS.has(action.action) });

  /** Outside changes (an editor, a terminal, another git client) refresh what moved, quietly. */
  onChangedRef.current = (c) => {
    if (!repoRef.current) return;
    pendingChange.current = {
      refs: pendingChange.current.refs || c.refs,
      worktree: pendingChange.current.worktree || c.worktree,
    };
    // Our own writes and a freshly opened repository's first load already cover what moved, and
    // a running operation refreshes when it ends. Anything that arrives meanwhile waits and is
    // applied afterwards instead of being dropped.
    const wait = Math.max(
      700 - (Date.now() - lastActEnd.current),
      2000 - (Date.now() - adoptedAt.current),
      busyRef.current ? 500 : 0,
    );
    window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(
      () => {
        const info = repoRef.current;
        const pending = pendingChange.current;
        pendingChange.current = { refs: false, worktree: false };
        if (!info) return;
        if (busyRef.current) return onChangedRef.current(pending);
        if (pending.refs) void refresh("all");
        else if (pending.worktree) void loadStatus(info);
      },
      Math.max(0, wait),
    );
  };

  const startWatching = (info: RepoInfo) => {
    if (watchId.current !== null) void unwatchRepo(watchId.current);
    watchId.current = watchRepo(info.id, (c) => onChangedRef.current(c));
  };

  // Background fetch on a timer (Settings → General). A failure (say, a login that is needed)
  // pauses it until the next time the user fetches by hand, so no prompt can keep reappearing.
  const autoFetchHealthy = useRef(true);
  useEffect(() => {
    if (!repo || autoFetchMinutes <= 0) return;
    autoFetchHealthy.current = true;
    const timer = window.setInterval(() => {
      const info = repoRef.current;
      if (!info || busyRef.current || document.hidden || !autoFetchHealthy.current) return;
      runGitOp(info.id, { op: "fetch", prune: autoPrune }, () => undefined, newOpId()).then(
        () => void refresh("all"),
        () => {
          autoFetchHealthy.current = false;
        },
      );
    }, autoFetchMinutes * 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id, autoFetchMinutes, autoPrune]);

  // ---- Graph gestures: drag and drop, and the right-click menu ----

  /** HEAD's branch and commit. The commit is found lazily: detached HEAD only shows in the graph rows. */
  const currentHead = (): Head => {
    const branch = status?.branch ?? null;
    const byRef = branch ? refs.find((r) => r.kind === "branch" && r.name === branch)?.target : undefined;
    const oid = byRef ?? store.current.rows.find((r) => r.refs.includes("HEAD"))?.oid ?? null;
    return { branch, oid };
  };

  /** Turns what the pointer touched into something the action rules understand. */
  const endpointFor = (s: Subject): Endpoint | null => {
    if (s.kind === "wip") return null;
    const row = store.current.rows[s.row];
    if (!row) return null;
    const parents = row.parents.length;
    const commit: Endpoint = { type: "commit", oid: row.oid, summary: row.summary, parents };
    if (s.kind === "commit") return commit;

    // The green HEAD badge stands for the checked-out branch, or for the commit if detached.
    const name = s.name === "HEAD" ? (status?.branch ?? null) : s.name;
    const ref = name ? refs.find((r) => r.name === name) : undefined;
    if (!ref) return commit;
    return { type: "ref", name: ref.name, kind: ref.kind, oid: ref.target, isHead: ref.is_head, parents };
  };

  const labelFor = (s: Subject): string => {
    const e = endpointFor(s);
    if (!e) return "";
    if (e.type === "ref") return e.name;
    return `${e.oid.slice(0, 7)} ${e.summary}`.slice(0, 60);
  };

  const hasTrackedChanges = !!status?.entries.some((e) => !e.untracked);

  const execute = (action: GraphAction, name: string) => {
    setConfirm(null);
    setMenu(null);
    const run = action.run;
    const opts: ActOptions = { done: `${action.confirmLabel} finished`, fail: `${action.confirmLabel} failed` };
    switch (run.type) {
      case "git":
        void gitOp(`${action.confirmLabel}…`, run.op, opts);
        break;
      case "switch":
        void act("Switching…", "all", (id) => switchRef(id, run.target), {
          done: "Checked out",
          fail: "Could not check out",
        });
        break;
      case "new_branch":
        void act("Creating branch…", "all", (id) => newBranch(id, name, run.start, true), {
          done: `Created ${name}`,
          fail: "Could not create the branch",
        });
        break;
      case "action": {
        const quick = typeof run.action === "function" ? run.action(name) : run.action;
        const title = quick.action.replace(/_/g, " ");
        void doAction(`${title}…`, quick, {
          done: `${title.replace(/^./, (c) => c.toUpperCase())} done`,
          fail: `${action.confirmLabel} failed`,
        });
        break;
      }
      case "create_pr":
        setPrBranch(run.branch);
        break;
      case "interactive_rebase":
        setRebaseBase({ oid: run.base, label: run.label });
        break;
      case "ui":
        run.run();
        break;
      case "copy":
        navigator.clipboard.writeText(run.text).then(
          () => toast.success("Copied to the clipboard"),
          () => toast.error("Could not access the clipboard"),
        );
        break;
    }
  };

  /** Quick actions run straight away; anything that changes history asks first. */
  const choose = (action: GraphAction) => {
    setMenu(null);
    if (action.immediate) execute(action, "");
    else setConfirm([action]);
  };

  const onDrop = (source: Subject, target: Subject) => {
    const [s, t] = [endpointFor(source), endpointFor(target)];
    if (!s || !t || busy) return;
    const { actions, reason } = dropActions(s, t, currentHead());
    if (actions.length > 0) setConfirm(actions);
    else if (reason) toast.info(reason);
  };

  /** Where this commit or branch lives on the host (GitHub or GitLab), or null without one. */
  const webLink = (kind: "commit" | "branch", value: string): string | null => {
    if (!hosting) return null;
    const base = hosting.web_url.replace(/\/$/, "");
    const dash = hosting.kind === "git_lab" ? "/-" : "";
    return kind === "commit" ? `${base}${dash}/commit/${value}` : `${base}${dash}/tree/${value}`;
  };

  /** Menu entries that need app state (sync, copy, export), shared by the graph and sidebar menus. */
  const appActions = (e: Endpoint): GraphAction[] => {
    const out: GraphAction[] = [];
    const plain = (id: string, title: string, run: GraphAction["run"]): GraphAction => ({
      id,
      title,
      description: "",
      confirmLabel: title,
      immediate: true,
      run,
    });
    const ui = (fn: () => void) => ({ type: "ui" as const, run: fn });
    if (e.type === "ref" && e.kind === "branch" && e.isHead) {
      if (status?.upstream) out.push(plain("pull-head", "Pull (fast-forward if possible)", { type: "git", op: { op: "pull", mode: pullMode } }));
      out.push(plain("push-head", status?.upstream ? "Push" : "Publish (set upstream)", { type: "git", op: { op: "push", set_upstream: !status?.upstream } }));
    }
    if (e.type === "ref" && e.kind !== "tag") {
      const name = e.kind === "remote" ? e.name.split("/").slice(1).join("/") : e.name;
      out.push(plain("copy-branch", "Copy branch name", { type: "copy", text: e.name }));
      const branchUrl = e.kind === "branch" ? webLink("branch", name) : null;
      if (branchUrl) out.push(plain("copy-link-branch", `Copy link to branch: ${e.name}`, { type: "copy", text: branchUrl }));
    }
    const commitUrl = webLink("commit", e.oid);
    if (commitUrl) out.push(plain("copy-link", `Copy link to this commit on ${hosting?.host}`, { type: "copy", text: commitUrl }));
    out.push(plain("patch", "Create patch from commit", ui(() => void doExportPatch({ source: "commit", oid: e.oid }))));
    return out;
  };

  const onMenu = (subject: Subject, x: number, y: number) => {
    const e = endpointFor(subject);
    if (!e || busy) return;
    setMenu({
      x,
      y,
      actions: [
        ...menuActions(e, currentHead()),
        ...appActions(e),
        ...(e.type === "ref" ? filterActions(e.name) : []),
      ].filter(
        (a) => a.id !== "create-pr" || hosting,
      ),
    });
  };

  /** Throwing changes away always asks first. Tracked files can be brought back with Undo; untracked ones cannot. */
  const askDiscard = (paths: string[], untracked: boolean) => {
    const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
    setConfirm([
      {
        id: "discard",
        title: `Discard changes to ${what}`,
        description: untracked
          ? `Deletes ${what} from disk. These files are not tracked by git, so nothing can bring them back.`
          : `Restores ${what} to the last committed version, dropping staged and unstaged edits.`,
        warning: untracked ? "This cannot be undone." : "Undo (Ctrl+Z) can bring this back until you close Perseus.",
        confirmLabel: "Discard",
        danger: true,
        run: { type: "action", action: { action: "discard", paths, untracked } },
      },
    ]);
  };

  /** Hides or isolates refs in the graph; remembered per repository. */
  const changeFilter = (next: GraphFilter) => {
    const info = repoRef.current;
    if (!info) return;
    filterRef.current = next;
    setFilter(next);
    writePref(`filter.${info.path}`, next);
    void loadGraph(info, true);
  };
  const hideRef = (name: string) =>
    changeFilter({ hidden: [...new Set([...filter.hidden, name])], solo: filter.solo.filter((s) => s !== name) });
  const soloRef = (name: string) => changeFilter({ hidden: [], solo: [name] });
  const clearFilter = () => changeFilter({ hidden: [], solo: [] });
  const filterCount = filter.hidden.length + filter.solo.length;

  /** Menu entries for hiding or isolating the ref the user clicked. */
  const filterActions = (name: string): GraphAction[] => [
    {
      id: "hide-ref",
      title: `Hide ${name} from the graph`,
      description: "",
      confirmLabel: "Hide",
      immediate: true,
      run: { type: "ui", run: () => hideRef(name) },
    },
    {
      id: "solo-ref",
      title: `Show only ${name}`,
      description: "",
      confirmLabel: "Show only",
      immediate: true,
      run: { type: "ui", run: () => soloRef(name) },
    },
    ...(filterCount > 0
      ? [
          {
            id: "clear-filter",
            title: "Show every branch again",
            description: "",
            confirmLabel: "Show all",
            immediate: true,
            run: { type: "ui" as const, run: clearFilter },
          },
        ]
      : []),
  ];

  const doOpenIn = async (target: "folder" | "terminal" | "editor") => {
    if (!repoRef.current) return;
    try {
      await openIn(repoRef.current.id, target);
    } catch (e) {
      report("Could not open it", e);
    }
  };

  const doClone = async (url: string) => {
    setCloneOpen(false);
    setBusy("Cloning…");
    setProgress("");
    const opId = newOpId();
    opIdRef.current = opId;
    setCancellable(true);
    try {
      const info = await cloneRepo(url, opId, setProgress);
      if (info) {
        toast.success(`Cloned ${info.name}`);
        await adopt(info);
      }
    } catch (e) {
      report("Clone failed", e);
    } finally {
      opIdRef.current = null;
      setCancellable(false);
      setBusy(null);
      setProgress("");
    }
  };

  const doInit = async () => {
    try {
      const info = await initRepo(readPref<string>(KEYS.defaultBranch, "main"));
      if (info) {
        toast.success(`Created a repository in ${info.name}`);
        await adopt(info);
      }
    } catch (e) {
      report("Could not create the repository", e);
    }
  };

  const doResolve = async (path: string, how: Resolution) => {
    const info = repoRef.current;
    if (!info) return false;
    try {
      await resolveConflict(info.id, path, how);
      toast.success(`Resolved ${path}`);
      await refresh("status");
      return true;
    } catch (e) {
      report("Could not resolve the conflict", e);
      return false;
    }
  };

  const doInteractiveRebase = async (items: TodoItem[]) => {
    const base = rebaseBase;
    setRebaseBase(null);
    if (!base) return;
    await act(
      "Rebasing…",
      "all",
      async (id) => {
        const opId = newOpId();
        opIdRef.current = opId;
        setCancellable(true);
        try {
          await interactiveRebase(id, base.oid, items, setProgress, opId);
        } finally {
          opIdRef.current = null;
          setCancellable(false);
        }
      },
      { done: "Rebase finished", fail: "Rebase stopped" },
    );
  };

  /** What a merge, rebase or cherry-pick would conflict on, asked of git without changing anything. */
  const predictFor = async (action: GraphAction): Promise<Prediction | null> => {
    const info = repoRef.current;
    if (!info || action.run.type !== "git") return null;
    const op = action.run.op;
    if (op.op === "merge") return predictMerge(info.id, "HEAD", op.rev);
    if (op.op === "rebase") return predictMerge(info.id, "HEAD", op.onto);
    if (op.op === "cherry_pick") return predictPick(info.id, "HEAD", op.oid);
    return null;
  };

  const onPrMenu = (pr: PullRequest, x: number, y: number) => {
    const info = repoRef.current;
    if (!info || busy) return;
    const label = `#${pr.number} ${pr.title}`;
    const merge = (method: MergeMethod, title: string, description: string): GraphAction => ({
      id: `merge-pr-${method}`,
      title,
      description: `${description} This changes the repository on ${hosting?.host}.`,
      confirmLabel: title,
      run: {
        type: "ui",
        run: () =>
          void act("Merging…", "all", (id) => mergePullRequest(id, pr.number, method), {
            done: `Merged #${pr.number}`,
            fail: "Could not merge",
          }).then((ok) => ok && void loadHosting(info)),
      },
    });
    setMenu({
      x,
      y,
      actions: [
        {
          id: "checkout-pr",
          title: `Check out ${label}`,
          description: "",
          confirmLabel: "Check out",
          immediate: true,
          run: {
            type: "ui",
            run: () =>
              void act(
                "Fetching the pull request…",
                "all",
                async (id) => {
                  const branch = await checkoutPullRequest(id, pr.number);
                  toast.info(`Checked out ${branch}`);
                },
                { fail: "Could not check out the pull request" },
              ),
          },
        },
        {
          id: "open-pr",
          title: "Open in the browser",
          description: "",
          confirmLabel: "Open",
          immediate: true,
          run: { type: "ui", run: () => void openInBrowser(info.id, pr.url).catch((e) => report("Could not open the page", e)) },
        },
        ...(pr.state === "open"
          ? [
              {
                id: "merge-pr",
                title: "Merge…",
                description: `Choose how to merge ${label}.`,
                confirmLabel: "Merge",
                run: {
                  type: "ui" as const,
                  run: () =>
                    setConfirm([
                      merge("merge", "Merge commit", "Adds a merge commit."),
                      merge("squash", "Squash and merge", "Combines the commits into one."),
                      merge("rebase", "Rebase and merge", "Replays the commits onto the target branch."),
                    ]),
                },
              },
            ]
          : []),
      ],
    });
  };

  const doCreatePr = async (head: string, title: string, body: string, base: string, draft: boolean) => {
    const info = repoRef.current;
    setPrBranch(null);
    if (!info) return;
    setBusy("Creating pull request…");
    try {
      const pr = await createPullRequest(info.id, { title, body, head, base, draft });
      toast.success(`Created #${pr.number}`, pr.url);
      void loadHosting(info);
    } catch (e) {
      report("Could not create the pull request", e);
    } finally {
      setBusy(null);
    }
  };

  const doExportPatch = async (source: PatchSource) => {
    const info = repoRef.current;
    if (!info) return;
    try {
      const saved = await exportPatch(info.id, source);
      if (saved) toast.success(`Saved ${saved.name}`, `${saved.bytes.toLocaleString()} bytes`);
    } catch (e) {
      report("Could not export the patch", e);
    }
  };

  const doApplyPatch = async (toIndex: boolean) => {
    const info = repoRef.current;
    if (!info) return;
    setBusy("Applying patch…");
    try {
      const name = await applyPatchFile(info.id, toIndex);
      if (name) toast.success(`Applied ${name}`);
    } catch (e) {
      report("The patch could not be applied", e);
    } finally {
      setBusy(null);
    }
    await refresh("all");
  };

  /** The message of the commit HEAD points at, for amending. Reads refs fresh: the cached list may lag a moment behind a commit made elsewhere. */
  const loadLastMessage = async () => {
    const info = repoRef.current;
    if (!info) return null;
    const now = await listRefs(info.id);
    const oid = now.find((r) => r.kind === "branch" && r.is_head)?.target ?? currentHead().oid;
    if (!oid) return null;
    return (await commitDetail(info.id, oid)).message.trim();
  };

  const loadTemplate = async () => (repoRef.current ? await commitTemplate(repoRef.current.id) : null);

  /** Stage, unstage or discard parts of a file's diff. Discarding asks first. */
  const applyPatch = (path: string, mode: PatchMode, hunks: HunkPick[], what: string) => {
    const action: GitAction = { action: "patch", path, mode, hunks };
    if (mode === "discard") {
      setConfirm([
        {
          id: "discard-parts",
          title: `Discard ${what} in ${path}`,
          description: `Removes ${what} from the file on disk, restoring the staged (or committed) version of those lines.`,
          warning: "Undo (Ctrl+Z) can bring this back until you close Perseus.",
          confirmLabel: "Discard",
          danger: true,
          run: { type: "action", action },
        },
      ]);
      return;
    }
    const verb = mode === "stage" ? "Staged" : "Unstaged";
    void doAction(mode === "stage" ? "Staging…" : "Unstaging…", action, {
      done: `${verb} ${what}`,
      fail: mode === "stage" ? "Could not stage" : "Could not unstage",
    });
  };

  /** Opens a submodule or linked worktree of the current repository in its own tab. */
  const openNested = async (path: string) => {
    const info = repoRef.current;
    if (!info) return;
    try {
      await adopt(await openNestedRepo(info.id, path));
    } catch (e) {
      report("Could not open it", e);
    }
  };

  const newWorktreeFor = async (branch: string) => {
    const info = repoRef.current;
    if (!info) return;
    try {
      const where = await addWorktree(info.id, branch, false);
      if (where) {
        toast.success(`Created a worktree for ${branch}`);
        void loadRefs(info);
      }
    } catch (e) {
      report("Could not create the worktree", e);
    }
  };

  const onStashMenu = (entry: StashEntry, x: number, y: number) => {
    if (busy) return;
    const label = entry.message.replace(/^(WIP on|On) [^:]+: /, "") || `stash ${entry.index}`;
    setMenu({
      x,
      y,
      actions: [
        {
          id: "stash-apply",
          title: `Apply “${label}”`,
          description: "",
          confirmLabel: "Apply",
          immediate: true,
          run: { type: "action", action: { action: "stash_apply", index: entry.index } },
        },
        {
          id: "stash-pop",
          title: `Pop “${label}” (apply and remove)`,
          description: "",
          confirmLabel: "Pop",
          immediate: true,
          run: { type: "action", action: { action: "stash_pop", index: entry.index } },
        },
        {
          id: "stash-drop",
          title: `Drop “${label}”`,
          description: "Removes this stash from the list.",
          warning: "Undo (Ctrl+Z) brings it back until you close Perseus; after that git fsck can sometimes recover it.",
          confirmLabel: "Drop",
          danger: true,
          run: { type: "action", action: { action: "stash_drop", index: entry.index } },
        },
      ],
    });
  };

  const onRefMenu = (ref: RefInfo, x: number, y: number) => {
    if (busy) return;
    const parents = store.current.rows[store.current.index.get(ref.target) ?? -1]?.parents.length;
    const e: Endpoint = { type: "ref", name: ref.name, kind: ref.kind, oid: ref.target, isHead: ref.is_head, parents };
    setMenu({
      x,
      y,
      actions: [
        ...menuActions(e, currentHead()),
        ...appActions(e),
        ...(ref.kind === "branch" && !ref.is_head
          ? [
              {
                id: "new-worktree",
                title: `Check out ${ref.name} in a new worktree…`,
                description: "",
                confirmLabel: "Choose folder",
                immediate: true,
                run: { type: "ui" as const, run: () => void newWorktreeFor(ref.name) },
              },
            ]
          : []),
        ...filterActions(ref.name),
      ].filter((a) => a.id !== "create-pr" || hosting),
    });
  };

  // ---- Opening and closing repositories ----

  const adopt = async (picked: RepoInfo) => {
    const previous = repoRef.current;
    if (previous && previous.id !== picked.id) await closeRepo(previous.id);
    repoRef.current = picked;
    const saved = readPref<GraphFilter>(`filter.${picked.path}`, { hidden: [], solo: [] });
    filterRef.current = saved;
    setFilter(saved);
    setTabs((t) => (t.some((x) => x.path === picked.path) ? t : [...t, { path: picked.path, name: picked.name }]));
    writePref("session.last", picked.path);
    adoptedAt.current = Date.now();
    wasInOperation.current = false;
    setRepo(picked);
    startWatching(picked);
    setRefs([]);
    setStashes([]);
    setRemotes([]);
    setStatus(null);
    setDiff(null);
    setSelected(null);
    setTab("commit");
    setHosting(null);
    setPulls([]);
    setIssues([]);
    setCi({});
    setHostingError(null);
    void loadGraph(picked);
    void loadRefs(picked);
    void loadStatus(picked);
    void loadHosting(picked);
    void reloadRecents();
  };

  const open = async () => {
    try {
      const picked = await pickAndOpenRepo();
      if (picked) await adopt(picked);
    } catch (e) {
      report("Could not open the repository", e);
    }
  };

  const openRecent = async (path: string) => {
    try {
      await adopt(await openRecentRepo(path));
    } catch (e) {
      report("Could not open the repository", e);
      void reloadRecents();
    }
  };

  const removeRecent = async (path: string) => {
    try {
      await removeRecentRepo(path);
    } finally {
      void reloadRecents();
    }
  };

  const closeTab = async (tab: RepoTab) => {
    const remaining = tabs.filter((t) => t.path !== tab.path);
    setTabs(remaining);
    if (repoRef.current?.path === tab.path) {
      const next = remaining[remaining.length - 1];
      if (next) await openRecent(next.path);
      else {
        writePref("session.last", null);
        await closeCurrent();
      }
    }
  };

  const closeCurrent = async () => {
    const info = repoRef.current;
    if (!info) return;
    if (streamId.current !== null) await cancelStream(streamId.current);
    repoRef.current = null;
    if (watchId.current !== null) void unwatchRepo(watchId.current);
    watchId.current = null;
    setRepo(null);
    setRefs([]);
    setStashes([]);
    setRemotes([]);
    setStatus(null);
    setDiff(null);
    setSelected(null);
    setDetail(null);
    setFiles([]);
    setLoaded("");
    store.current.clear();
    setCount(0);
    try {
      await closeRepo(info.id);
    } catch (e) {
      report("Could not close the repository", e);
    }
    void reloadRecents();
  };

  // ---- Selection ----

  const select = useCallback(
    (row: number) => {
      setSelected(row);
      setTab("commit");
      const commit = store.current.rows[row];
      if (!repo || !commit) return;
      const seq = ++detailSeq.current;
      setDetailLoading(true);
      Promise.all([commitDetail(repo.id, commit.oid), commitFiles(repo.id, commit.oid)]).then(
        ([d, f]) => {
          if (seq !== detailSeq.current) return; // a newer selection superseded this one
          setDetail(d);
          setFiles(f);
          setDetailError(null);
          setDetailLoading(false);
        },
        (e) => {
          if (seq !== detailSeq.current) return;
          setDetail(null);
          setFiles([]);
          setDetailError(String(e));
          setDetailLoading(false);
        },
      );
    },
    [repo],
  );

  const selectWip = useCallback(() => {
    setSelected("wip");
    setTab("changes");
  }, []);

  const jumpTo = useCallback(
    (oid: string) => {
      const row = store.current.index.get(oid);
      if (row === undefined) {
        toast.info("That commit has not loaded yet");
        return;
      }
      select(row);
      setReveal((r) => ({ row, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [select, toast],
  );

  const gotoCommit = useCallback(
    (prefix: string) => {
      const p = prefix.toLowerCase();
      const row = store.current.rows.findIndex((r) => r.oid.startsWith(p));
      if (row < 0) toast.info("No loaded commit starts with that id");
      else jumpTo(store.current.rows[row].oid);
    },
    [jumpTo, toast],
  );

  const checkout = (r: RefInfo) =>
    act(
      "Switching…",
      "all",
      (id) =>
        switchRef(id, {
          kind: "branch",
          // `origin/topic` → `topic`: git creates a tracking branch if it is the only match.
          name: r.kind === "remote" ? r.name.split("/").slice(1).join("/") : r.name,
        }),
      { done: `Checked out ${r.name}`, fail: "Could not check out" },
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

  const reloadProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      report("Could not load profiles", e);
    }
  }, [report]);

  useEffect(() => {
    void reloadProfiles();
    void reloadRecents();
  }, [reloadProfiles, reloadRecents]);

  // Warn about big files in the next commit; the check runs only when the staged set changes.
  const stagedKey = status?.entries.filter((e) => e.index).map((e) => e.path).join("\0") ?? "";
  useEffect(() => {
    const info = repoRef.current;
    const limit = readPref<number>(KEYS.largeFile, LARGE_FILE_DEFAULT);
    if (!info || !stagedKey || limit <= 0) {
      setLargeFiles([]);
      return;
    }
    let live = true;
    largeStagedFiles(info.id, limit).then(
      (l) => live && setLargeFiles(l),
      () => live && setLargeFiles([]),
    );
    return () => {
      live = false;
    };
  }, [stagedKey, settingsOpen]);

  // Git and ssh ask their questions (passwords, passphrases, host trust) through the window.
  useEffect(() => {
    watchAskpass((q) => setQuestions((l) => [...l, q]));
  }, []);

  const answerQuestion = (answer: string | null) => {
    const q = questions[0];
    if (!q) return;
    setQuestions((l) => l.slice(1));
    void answerAskpass(q.id, answer);
  };

  // Whether the selected commit is signed.
  useEffect(() => {
    setSignature(null);
    const info = repoRef.current;
    if (!info || !detail) return;
    let live = true;
    commitSignature(info.id, detail.oid).then(
      (s) => live && setSignature(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [detail]);

  // The profile follows the repository: an explicit pin, or a rule that matches a remote.
  useEffect(() => {
    if (!repo || !profiles || autoProfileFor.current === repo.id) return;
    const pinned = readPref<string | null>(`repoProfile.${repo.path}`, null);
    if (!pinned && remotes.length === 0) return; // remotes are still loading
    autoProfileFor.current = repo.id;
    const id = profileFor(pinned, readPref<ProfileRule[]>(RULES_KEY, []), remotes.map((r) => r.fetch_url));
    if (id && id !== profiles.active && profiles.profiles.some((p) => p.id === id)) void switchProfile(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, remotes, profiles]);

  // Reopen where the user left off. Only a path already in the recents list can be opened.
  useEffect(() => {
    if (restored.current || recents.length === 0) return;
    restored.current = true;
    // Tabs only make sense for repositories that still exist.
    setTabs((t) => t.filter((x) => recents.some((r) => r.path === x.path && r.exists)));
    const last = readPref<string | null>("session.last", null);
    if (last && recents.some((r) => r.path === last && r.exists)) void openRecent(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recents]);

  const activeProfile = profiles?.profiles.find((p) => p.id === profiles.active) ?? null;
  const identity = activeProfile ? { name: activeProfile.user_name, email: activeProfile.user_email } : null;

  const switchProfile = async (id: string | null) => {
    try {
      await setActiveProfile(id);
      await reloadProfiles();
      toast.success(id ? "Profile switched" : "Using your Git configuration");
    } catch (e) {
      report("Could not switch profile", e);
    }
  };

  // ---- Derived data for the graph ----

  const wip = useMemo<WipSummary | null>(() => {
    if (!status || status.entries.length === 0) return null;
    let additions = 0;
    let deletions = 0;
    for (const e of status.entries) {
      for (const s of [e.index_stats, e.worktree_stats]) {
        additions += s?.additions ?? 0;
        deletions += s?.deletions ?? 0;
      }
    }
    return { files: status.entries.length, additions, deletions };
  }, [status]);

  // The working-tree row only exists while there are changes; drop a stale selection of it.
  useEffect(() => {
    if (!wip) setSelected((s) => (s === "wip" ? null : s));
  }, [wip]);

  const refKinds = useMemo(() => new Map(refs.map((r) => [r.name, r.kind] as const)), [refs]);

  const headRow = useMemo(() => {
    const branch = status?.branch;
    const oid = branch ? refs.find((r) => r.kind === "branch" && r.name === branch)?.target : undefined;
    if (oid) return store.current.index.get(oid) ?? null;
    if (branch === null || branch === undefined) {
      const i = store.current.rows.findIndex((r) => r.refs.includes("HEAD"));
      return i >= 0 ? i : null;
    }
    return null;
    // `count` re-runs this while history streams in, so HEAD is found as soon as its row arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.branch, refs, count]);

  // ---- Keyboard ----

  const overlayOpen = paletteOpen || shortcutsOpen || settingsOpen || profilesOpen || newBranchOpen || !!confirm || !!menu;
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const target = e.target as HTMLElement | null;
    const typing = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    const key = e.key.toLowerCase();
    if (mod && (key === "k" || key === "p")) {
      e.preventDefault();
      setPaletteOpen((o) => !o);
    } else if (mod && key === "o") {
      e.preventDefault();
      if (!busy) void open();
    } else if (mod && key === "f" && repo) {
      e.preventDefault();
      setSearchOpen(true);
    } else if (mod && key === "z" && repo && !typing) {
      e.preventDefault();
      void stepHistory(e.shiftKey ? "redo" : "undo");
    } else if (mod && key === "y" && repo && !typing) {
      e.preventDefault();
      void stepHistory("redo");
    } else if (mod && e.key === ",") {
      e.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else openSettings();
    } else if (mod && key === "b" && repo) {
      e.preventDefault();
      setSidebarOpen((o) => !o);
    } else if (e.key === "F5" || (mod && key === "r")) {
      e.preventDefault();
      void refresh("all");
      void reloadRecents();
    } else if (e.key === "Escape" && diff && !overlayOpen) {
      setDiff(null);
    } else if (e.key === "?" && !typing && !overlayOpen) {
      setShortcutsOpen(true);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- Command palette ----

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const add = (i: PaletteItem) => out.push(i);
    const publish = !!status?.branch && !status.upstream;

    add({ id: "open", title: "Open repository…", group: "Actions", icon: FolderOpen, shortcut: "Ctrl+O", run: () => void open() });
    add({ id: "clone", title: "Clone a repository…", group: "Actions", icon: Download, run: () => setCloneOpen(true) });
    add({ id: "init", title: "Create a new repository…", group: "Actions", icon: FolderPlus, run: () => void doInit() });
    if (repo) {
      add({ id: "fetch", title: "Fetch", group: "Actions", icon: RefreshCw, run: () => void gitOp("Fetching…", fetchOp(), { done: "Fetch complete", fail: "Fetch failed" }) });
      if (status?.upstream)
        add({ id: "pull", title: "Pull", group: "Actions", icon: ArrowDownToLine, run: () => void gitOp("Pulling…", { op: "pull", mode: pullMode }, { done: "Pulled", fail: "Pull failed" }) });
      if (status?.branch)
        add({
          id: "push",
          title: publish ? "Publish branch" : "Push",
          group: "Actions",
          icon: ArrowUpFromLine,
          run: () => void gitOp(publish ? "Publishing…" : "Pushing…", { op: "push", set_upstream: publish }, { done: publish ? "Published" : "Pushed", fail: "Push failed" }),
        });
      if (hosting) add({ id: "hosting-refresh", title: "Refresh pull requests and issues", group: "Actions", icon: History, run: () => repoRef.current && void loadHosting(repoRef.current) });
      add({ id: "search", title: "Search commits…", group: "Actions", icon: Search, shortcut: "Ctrl+F", run: () => setSearchOpen(true) });
      add({ id: "stash", title: "Stash changes…", group: "Actions", icon: Archive, run: () => setStashOpen(true) });
      add({ id: "patch-export", title: "Export unstaged changes as a patch…", group: "Actions", icon: Archive, run: () => void doExportPatch({ source: "worktree", staged: false }) });
      add({ id: "patch-export-staged", title: "Export staged changes as a patch…", group: "Actions", icon: Archive, run: () => void doExportPatch({ source: "worktree", staged: true }) });
      add({ id: "patch-apply", title: "Apply a patch file…", group: "Actions", icon: Archive, run: () => void doApplyPatch(false) });
      add({ id: "patch-apply-index", title: "Apply a patch file and stage it…", group: "Actions", icon: Archive, run: () => void doApplyPatch(true) });
      add({ id: "remotes", title: "Manage remotes…", group: "Actions", icon: Cable, run: () => setRemotesOpen(true) });
      if (status?.upstream) {
        add({ id: "pull-merge", title: "Pull (merge)", group: "Actions", icon: ArrowDownToLine, run: () => void gitOp("Pulling…", { op: "pull", mode: "merge" }, { done: "Pulled", fail: "Pull failed" }) });
        add({ id: "pull-rebase", title: "Pull (rebase)", group: "Actions", icon: ArrowDownToLine, run: () => void gitOp("Pulling…", { op: "pull", mode: "rebase" }, { done: "Pulled", fail: "Pull failed" }) });
      }
      if (cancellable) add({ id: "cancel", title: "Cancel the running operation", group: "Actions", icon: X, run: cancelRunning });
      add({ id: "undo", title: "Undo", subtitle: lastOf(undoStack(repo.path).undo)?.label, group: "Actions", icon: Undo2, shortcut: "Ctrl+Z", run: () => void stepHistory("undo") });
      add({ id: "redo", title: "Redo", subtitle: lastOf(undoStack(repo.path).redo)?.label, group: "Actions", icon: Redo2, shortcut: "Ctrl+Shift+Z", run: () => void stepHistory("redo") });
      add({ id: "refresh", title: "Refresh", group: "Actions", icon: History, shortcut: "F5", run: () => void refresh("all") });
      add({ id: "newbranch", title: "New branch…", group: "Actions", icon: GitBranchPlus, run: () => setNewBranchOpen(true) });
      add({ id: "sidebar", title: sidebarOpen ? "Hide sidebar" : "Show sidebar", group: "Actions", icon: PanelLeft, shortcut: "Ctrl+B", run: () => setSidebarOpen((o) => !o) });
      add({ id: "open-folder", title: "Show in file manager", group: "Actions", icon: FolderOpen, run: () => void doOpenIn("folder") });
      add({ id: "open-terminal", title: "Open in terminal", group: "Actions", icon: Terminal, run: () => void doOpenIn("terminal") });
      add({ id: "open-editor", title: "Open in editor (VS Code)", group: "Actions", icon: Code2, run: () => void doOpenIn("editor") });
      add({ id: "close", title: "Close repository", group: "Actions", icon: X, run: () => void closeCurrent() });
    }
    add({ id: "theme-light", title: "Theme: Light", group: "Actions", icon: Sun, run: () => setTheme("light") });
    add({ id: "theme-dark", title: "Theme: Dark", group: "Actions", icon: Moon, run: () => setTheme("dark") });
    add({ id: "theme-system", title: "Theme: Follow system", group: "Actions", icon: Sun, run: () => setTheme("system") });
    add({ id: "profiles", title: "Manage profiles…", group: "Actions", icon: Users, run: () => setProfilesOpen(true) });
    add({ id: "shortcuts", title: "Keyboard shortcuts", group: "Actions", icon: Keyboard, shortcut: "?", run: () => setShortcutsOpen(true) });
    add({ id: "settings", title: "Settings…", group: "Actions", icon: Settings, shortcut: "Ctrl+,", run: () => openSettings() });
    add({ id: "activity", title: "Activity log", group: "Actions", icon: History, run: () => openSettings("activity") });

    for (const r of refs) {
      if (r.kind === "tag") {
        add({ id: `tag:${r.name}`, title: `Go to tag ${r.name}`, group: "Branches", icon: Tag, run: () => jumpTo(r.target) });
      } else if (!r.is_head) {
        add({
          id: `co:${r.kind}:${r.name}`,
          title: `Check out ${r.name}`,
          subtitle: r.kind === "remote" ? "remote branch" : "local branch",
          group: "Branches",
          icon: GitBranch,
          run: () => void checkout(r),
        });
      }
    }

    if (profiles) {
      add({ id: "prof:", title: "Use system default identity", group: "Profiles", icon: User, run: () => void switchProfile(null) });
      for (const p of profiles.profiles)
        add({ id: `prof:${p.id}`, title: `Use profile ${p.name}`, subtitle: p.user_email, group: "Profiles", icon: User, run: () => void switchProfile(p.id) });
    }

    for (const r of recents)
      if (r.exists && r.path !== repo?.path)
        add({ id: `rec:${r.path}`, title: `Open ${r.name}`, subtitle: r.path, group: "Repositories", icon: FolderOpen, run: () => void openRecent(r.path) });
    return out;
    // The closures above read current state; the palette is rebuilt whenever any of it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, status, refs, profiles, recents, sidebarOpen, busy, cancellable]);

  const menuItems = (actions: GraphAction[]): MenuItem[] => layoutMenu(actions, status?.branch ?? null);

  const changeCount = status?.entries.length ?? 0;
  const publish = !!status?.branch && !status.upstream;
  const maxDiffH = Math.max(160, window.innerHeight - 280);

  return (
    <div className={toolbarLabels ? "app" : "app icons-only"}>
      {tabs.length > 0 && repo && (
        <RepoTabs
          tabs={tabs}
          activePath={repo.path}
          onSelect={(t) => t.path !== repo.path && void openRecent(t.path)}
          onClose={(t) => void closeTab(t)}
          onNew={() => void open()}
        />
      )}

      {settingsOpen && (
        <SettingsPage
          repo={repo}
          profiles={profiles}
          theme={theme}
          onTheme={setTheme}
          initialPage={settingsPage}
          onExit={() => setSettingsOpen(false)}
          onManageProfiles={() => setProfilesOpen(true)}
          onSwitchProfile={(id) => void switchProfile(id)}
        />
      )}

      {/* Stays mounted while settings are open, so the graph keeps its place. */}
      <div className="main-view" style={{ display: settingsOpen ? "none" : "contents" }}>
      <Toolbar
        repo={repo}
        status={status}
        busy={!!busy}
        loading={loading}
        recents={recents}
        refs={refs}
        profiles={profiles}
        sidebarOpen={sidebarOpen}
        theme={theme}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onOpen={() => void open()}
        onOpenRecent={(p) => void openRecent(p)}
        onCheckout={(r) => void checkout(r)}
        onFetch={() => void gitOp("Fetching…", fetchOp(), { done: "Fetch complete", fail: "Fetch failed" })}
        onPull={() => void gitOp("Pulling…", { op: "pull", mode: pullMode }, { done: "Pulled", fail: "Pull failed" })}
        pullMode={pullMode}
        onPullMode={(m) => {
          setPullMode(m);
          toast.info(
            { ff_only: "Pull refuses when history has diverged", merge: "Pull creates a merge commit", rebase: "Pull rebases your commits" }[m],
          );
        }}
        onPushVariant={(v) => {
          if (v === "tags") {
            void gitOp("Pushing tags…", { op: "push", tags: true }, { done: "Tags pushed", fail: "Push failed" });
          } else {
            setConfirm([
              {
                id: "force-push",
                title: "Force push with lease",
                description: `Overwrites ${status?.upstream ?? "the remote branch"} with your ${status?.branch ?? "branch"}. The lease makes git refuse if somebody else pushed commits you have not fetched.`,
                warning: "This rewrites the remote's history. Teammates who already pulled it will have to repair their copies.",
                confirmLabel: "Force push",
                danger: true,
                run: { type: "git", op: { op: "push", force_with_lease: true } },
              },
            ]);
          }
        }}
        onStash={() => setStashOpen(true)}
        onClone={() => setCloneOpen(true)}
        onInit={() => void doInit()}
        filterCount={filterCount}
        onClearFilter={clearFilter}
        onPush={() =>
          void gitOp(
            publish ? "Publishing…" : "Pushing…",
            { op: "push", set_upstream: publish },
            { done: publish ? "Published" : "Pushed", fail: "Push failed" },
          )
        }
        onPalette={() => setPaletteOpen(true)}
        onCancelLoad={() => streamId.current !== null && void cancelStream(streamId.current)}
        onProfiles={() => setProfilesOpen(true)}
        onSwitchProfile={(id) => void switchProfile(id)}
        onPinProfile={() => {
          if (!repo || !activeProfile) return;
          writePref(`repoProfile.${repo.path}`, activeProfile.id);
          toast.success(`${repo.name} will always use ${activeProfile.name}`);
        }}
        onTheme={setTheme}
        onShortcuts={() => setShortcutsOpen(true)}
        onPreferences={() => openSettings()}
        onNewBranch={() => setNewBranchOpen(true)}
        undoLabel={repo ? (lastOf(undoStack(repo.path).undo)?.label ?? null) : null}
        redoLabel={repo ? (lastOf(undoStack(repo.path).redo)?.label ?? null) : null}
        onUndo={() => void stepHistory("undo")}
        onRedo={() => void stepHistory("redo")}
        onPop={() =>
          void doAction("Popping the stash…", { action: "stash_pop", index: 0 }, { done: "Stash applied and removed", fail: "Could not pop the stash" })
        }
        stashCount={stashes.length}
      />

      {repo ? (
        <div className="workspace">
          {sidebarOpen && (
            <>
              <aside className="pane pane-side" style={{ width: sidebarW }}>
                <Sidebar
                  refs={refs}
                  stashes={stashes}
                  hidden={new Set(filter.hidden)}
                  solo={new Set(filter.solo)}
                  hosting={hosting}
                  pulls={pulls}
                  issues={issues}
                  ci={ci}
                  hostingError={hostingError}
                  onPrMenu={onPrMenu}
                  onOpenIssue={(i) => repo && void openInBrowser(repo.id, i.url).catch((e) => report("Could not open the page", e))}
                  onStashMenu={onStashMenu}
                  extras={
                    <ExtrasSections
                      repoId={repo.id}
                      version={refs}
                      busy={!!busy}
                      onOpen={(p) => void openNested(p)}
                      onUpdateSubmodules={(p) =>
                        void act("Updating submodules…", "all", (id) => updateSubmodules(id, p), {
                          done: "Submodules updated",
                          fail: "Could not update the submodules",
                        })
                      }
                      onRemoveWorktree={(w) =>
                        setConfirm([
                          {
                            id: "remove-worktree",
                            title: `Remove the worktree for ${w.branch ?? w.path}`,
                            description: `Deletes the folder ${w.path}. Commits stay in the repository.`,
                            warning: "Uncommitted changes in that folder are lost.",
                            confirmLabel: "Remove",
                            danger: true,
                            run: {
                              type: "ui",
                              run: () =>
                                void act("Removing worktree…", "all", (id) => removeWorktree(id, w.path), {
                                  done: "Worktree removed",
                                  fail: "Could not remove the worktree",
                                }),
                            },
                          },
                        ])
                      }
                      onTrackLfs={(pattern) =>
                        void act("Updating LFS…", "all", (id) => lfsTrack(id, pattern), {
                          done: `Tracking ${pattern} with LFS`,
                          fail: "Could not track the pattern",
                        })
                      }
                    />
                  }
                  busy={!!busy}
                  onJump={jumpTo}
                  onCheckout={(r) => void checkout(r)}
                  onCreateBranch={(name) =>
                    void act("Creating branch…", "all", (id) => newBranch(id, name, null, true), {
                      done: `Created ${name}`,
                      fail: "Could not create the branch",
                    })
                  }
                  onMenu={onRefMenu}
                />
              </aside>
              <Splitter
                orientation="vertical"
                label="Resize sidebar"
                value={sidebarW}
                min={190}
                max={440}
                reset={248}
                onChange={setSidebarW}
              />
            </>
          )}

          <section className="pane-center">
            <div className="graph-area">
              <GraphCanvas
                store={store.current}
                count={count}
                loading={loading}
                selected={selected}
                onSelect={select}
                onSelectWip={selectWip}
                reveal={reveal}
                onDrop={onDrop}
                onActivateRef={(name) => {
                  const r = refs.find((x) => x.name === name);
                  if (r && r.kind !== "tag" && !r.is_head && !busy) void checkout(r);
                }}
                onMenu={onMenu}
                labelFor={labelFor}
                wip={wip}
                headRow={headRow}
                headBranch={status?.branch ?? null}
                refKinds={refKinds}
                refsW={refsW}
                dateStyle={dateStyle}
                showRefs={showRefs}
                showAuthor={showAuthor}
                showDate={showDate}
                ghost={ghostBranch}
                bands={rowBands}
                onResizeRefs={setRefsW}
                authorW={authorW}
                dateW={dateW}
                onResizeAuthor={setAuthorW}
                onResizeDate={setDateW}
              />
            </div>
            {diff && (
              <>
                <Splitter
                  orientation="horizontal"
                  label="Resize diff"
                  value={Math.min(diffH, maxDiffH)}
                  min={120}
                  max={maxDiffH}
                  reset={320}
                  invert
                  onChange={setDiffH}
                />
                <div className="diff-area" style={{ height: Math.min(diffH, maxDiffH) }}>
                  <DiffView
                    repoId={repo.id}
                    target={diff}
                    version={diffVersion}
                    onClose={() => setDiff(null)}
                    onPatch={applyPatch}
                    busy={!!busy}
                  />
                </div>
              </>
            )}
          </section>

          <Splitter
            orientation="vertical"
            label="Resize details panel"
            value={rightW}
            min={320}
            max={700}
            reset={380}
            invert
            onChange={setRightW}
          />
          <aside className="pane pane-right" style={{ width: rightW }}>
            <div className="tabs" role="tablist" aria-label="Details">
              <button role="tab" aria-selected={tab === "commit"} onClick={() => setTab("commit")}>
                Commit
              </button>
              <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
                Changes
                {changeCount > 0 && <Badge tone="accent">{changeCount}</Badge>}
              </button>
            </div>
            <div className="tab-panel" role="tabpanel">
              {tab === "commit" ? (
                <DetailPanel
                  detail={detail}
                  files={files}
                  loading={detailLoading}
                  error={detailError}
                  activeDiff={diff}
                  onJump={jumpTo}
                  onOpenFile={(oid, f) => setDiff({ kind: "commit", oid, path: f.path, orig: f.orig_path })}
                  onFileHistory={setHistoryPath}
                  signature={signature}
                  onExportPatch={(oid) => void doExportPatch({ source: "commit", oid })}
                />
              ) : (
                <ChangesPanel
                  largeFiles={largeFiles}
                  onTrackLarge={(pattern) =>
                    void act("Updating LFS…", "all", (id) => lfsTrack(id, pattern), {
                      done: `Tracking ${pattern} with LFS`,
                      fail: "Could not track the pattern",
                    })
                  }
                  status={status}
                  busy={!!busy}
                  activeDiff={diff}
                  identity={identity}
                  onOpenDiff={setDiff}
                  onStage={(paths) => void act("Staging…", "status", (id) => stagePaths(id, paths), { fail: "Could not stage", files: true })}
                  onUnstage={(paths) =>
                    void act("Unstaging…", "status", (id) => unstagePaths(id, paths), { fail: "Could not unstage", files: true })
                  }
                  skipHooksDefault={skipHooksDefault}
                  onCommit={async (message, amend, noVerify) => {
                    const ok = await act(amend ? "Amending…" : "Committing…", "all", (id) => createCommit(id, message, amend, noVerify), {
                      done: amend ? "Amended the last commit" : "Committed",
                      fail: "Commit failed",
                    });
                    const info = repoRef.current;
                    if (ok && !amend && info && status?.upstream && readPref<boolean>(repoKey(info.path, "pushAfterCommit"), false)) {
                      void gitOp("Pushing…", { op: "push" }, { done: "Pushed", fail: "Push failed" });
                    }
                    return ok;
                  }}
                  onDiscard={askDiscard}
                  onResolve={setResolvePath}
                  loadLastMessage={loadLastMessage}
                  loadTemplate={loadTemplate}
                  onStash={() => setStashOpen(true)}
                  onContinue={() => void gitOp("Continuing…", { op: "continue" }, { done: "Continued", fail: "Could not continue" })}
                  onAbort={() => void gitOp("Aborting…", { op: "abort" }, { done: "Aborted", fail: "Could not abort" })}
                />
              )}
            </div>
          </aside>
        </div>
      ) : (
        <Welcome
          recents={recents}
          busy={!!busy}
          onOpen={() => void open()}
          onOpenRecent={(p) => void openRecent(p)}
          onRemoveRecent={(p) => void removeRecent(p)}
          onPalette={() => setPaletteOpen(true)}
          onClone={() => setCloneOpen(true)}
          onInit={() => void doInit()}
        />
      )}
      </div>

      <StatusBar
        repo={repo}
        busy={busy}
        progress={progress}
        loading={loading}
        loaded={loaded}
        commitCount={count}
        identity={identity}
        lastError={lastError?.title ?? null}
        onShowError={() => lastError && toast.error(lastError.title, lastError.detail)}
        onCancel={cancellable ? cancelRunning : undefined}
      />

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          minWidth={280}
          items={menuItems(menu.actions)}
          onClose={() => setMenu(null)}
          onPick={(id) => {
            const a = menu.actions.find((x) => x.id === id);
            if (a) choose(a);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          actions={confirm}
          dirty={hasTrackedChanges}
          onConfirm={execute}
          onCancel={() => setConfirm(null)}
          predict={predictFor}
        />
      )}
      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} onGotoCommit={gotoCommit} />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {stashOpen && status && (
        <StashDialog
          changed={status.entries.length}
          untracked={status.entries.filter((e) => e.untracked).length}
          onClose={() => setStashOpen(false)}
          onStash={(message, includeUntracked) => {
            setStashOpen(false);
            void doAction(
              "Stashing…",
              { action: "stash_push", message: message || null, include_untracked: includeUntracked },
              { done: "Changes stashed", fail: "Could not stash" },
            );
          }}
        />
      )}
      {resolvePath && repo && (
        <ConflictDialog repoId={repo.id} path={resolvePath} onResolve={doResolve} onClose={() => setResolvePath(null)} />
      )}
      {rebaseBase && repo && (
        <RebaseDialog
          repoId={repo.id}
          base={rebaseBase.oid}
          baseLabel={rebaseBase.label}
          onStart={(items) => void doInteractiveRebase(items)}
          onClose={() => setRebaseBase(null)}
        />
      )}
      {questions[0] && <AskpassDialog key={questions[0].id} question={questions[0]} onAnswer={answerQuestion} />}
      {prBranch && repo && (
        <CreatePrDialog
          head={prBranch}
          bases={refs.filter((r) => r.kind === "branch" && r.name !== prBranch).map((r) => r.name)}
          defaultBase={
            refs.find((r) => r.kind === "branch" && ["main", "master", "develop"].includes(r.name) && r.name !== prBranch)?.name ??
            refs.find((r) => r.kind === "branch" && r.name !== prBranch)?.name ??
            "main"
          }
          defaultTitle={store.current.rows.find((r) => r.refs.includes(prBranch))?.summary ?? prBranch}
          notPushed={!refs.some((r) => r.kind === "remote" && r.name.endsWith(`/${prBranch}`))}
          onClose={() => setPrBranch(null)}
          onCreate={(title, body, base, draft) => void doCreatePr(prBranch, title, body, base, draft)}
        />
      )}
      {searchOpen && repo && (
        <SearchDialog
          repoId={repo.id}
          onClose={() => setSearchOpen(false)}
          onJump={(oid) => {
            setSearchOpen(false);
            jumpTo(oid);
          }}
        />
      )}
      {cloneOpen && <CloneDialog onClose={() => setCloneOpen(false)} onClone={(url) => void doClone(url)} />}
      {historyPath && repo && (
        <FileHistoryDialog
          repoId={repo.id}
          path={historyPath}
          onClose={() => setHistoryPath(null)}
          onJump={(oid) => {
            setHistoryPath(null);
            jumpTo(oid);
          }}
        />
      )}
      {remotesOpen && (
        <RemotesDialog
          remotes={remotes}
          onClose={() => setRemotesOpen(false)}
          onAction={(action, done) => doAction("Updating remotes…", action, { done, fail: "Remote change failed" })}
        />
      )}
      {newBranchOpen && (
        <NewBranchDialog
          from={status?.branch ?? "the current commit"}
          onClose={() => setNewBranchOpen(false)}
          onCreate={(name) => {
            setNewBranchOpen(false);
            void act("Creating branch…", "all", (id) => newBranch(id, name, null, true), {
              done: `Created ${name}`,
              fail: "Could not create the branch",
            });
          }}
        />
      )}
      {profilesOpen && profiles && (
        <ProfilesDialog
          snapshot={profiles}
          onChanged={reloadProfiles}
          onClose={() => {
            setProfilesOpen(false);
            // Credentials or identity may have changed what git operations will do.
            if (repoRef.current) void loadStatus(repoRef.current);
          }}
        />
      )}
    </div>
  );
}

export default App;
