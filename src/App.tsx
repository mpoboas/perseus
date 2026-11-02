import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  History,
  Keyboard,
  Moon,
  PanelLeft,
  RefreshCw,
  Sun,
  Tag,
  User,
  Users,
  X,
} from "lucide-react";
import { type Endpoint, type GraphAction, type Head, dropActions, menuActions } from "./actions";
import { ChangesPanel } from "./ChangesPanel";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { CommitStore } from "./commitStore";
import { ConfirmDialog } from "./ConfirmDialog";
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
  type ProfilesSnapshot,
  type RecentRepo,
  type RefInfo,
  type RepoInfo,
  type RepoStatus,
  cancelStream,
  closeRepo,
  commitDetail,
  commitFiles,
  createCommit,
  listProfiles,
  listRecentRepos,
  listRefs,
  newBranch,
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
  unwatchRepo,
  watchRepo,
} from "./ipc";
import { usePref } from "./lib/prefs";
import { useThemePref } from "./lib/theme";
import { NewBranchDialog } from "./NewBranchDialog";
import { ProfilesDialog } from "./ProfilesDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { Badge, Menu, type MenuItem, Splitter, useToast } from "./ui";
import { Welcome } from "./Welcome";

type Tab = "commit" | "changes";

interface ActOptions {
  /** Toast shown when the action succeeds (quiet by default). */
  done?: string;
  /** Title of the error toast. */
  fail?: string;
}

function App() {
  const toast = useToast();
  const [theme, setTheme] = useThemePref();

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [refs, setRefs] = useState<RefInfo[]>([]);
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
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: GraphAction[] } | null>(null);
  const [confirm, setConfirm] = useState<GraphAction[] | null>(null);

  const [sidebarOpen, setSidebarOpen] = usePref("layout.sidebarOpen", true);
  const [sidebarW, setSidebarW] = usePref("layout.sidebarW", 248);
  const [rightW, setRightW] = usePref("layout.rightW", 380);
  const [diffH, setDiffH] = usePref("layout.diffH", 320);
  const [authorW, setAuthorW] = usePref("layout.authorW", 170);
  const [dateW, setDateW] = usePref("layout.dateW", 96);

  // Rows live outside React state: chunks of 500 would otherwise trigger a re-render each.
  const store = useRef(new CommitStore());
  const streamId = useRef<number | null>(null);
  const frame = useRef(0);
  const detailSeq = useRef(0);
  const wasInOperation = useRef(false);
  const selectedRef = useRef<number | "wip" | null>(null);
  /** Commit to re-select once a reload finishes (row numbers change when history reloads). */
  const keepOid = useRef<string | null>(null);
  const watchId = useRef<number | null>(null);
  const busyRef = useRef<string | null>(null);
  const lastActEnd = useRef(0);
  const onChangedRef = useRef<(c: ChangeSet) => void>(() => undefined);
  const repoRef = useRef<RepoInfo | null>(null);
  repoRef.current = repo;
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
      const { streamId: id, done } = streamCommits(info.id, (chunk) => {
        target.push(chunk);
        if (!silent) scheduleCount();
      });
      streamId.current = id;
      try {
        const summary = await done;
        if (silent && (summary.cancelled || streamId.current !== id)) return;
        if (silent) store.current = target;
        setCount(target.length);
        if (keepOid.current) {
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
        keepOid.current = null;
        if (streamId.current === id) {
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
        const r = await listRefs(info.id);
        if (repoRef.current?.id === info.id) setRefs(r);
      } catch (e) {
        report("Could not list branches", e);
      }
    },
    [report],
  );

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
      let ok = true;
      try {
        await fn(info.id);
        if (opts.done) toast.success(opts.done);
      } catch (e) {
        ok = false;
        report(opts.fail ?? "That did not work", e);
      } finally {
        setBusy(null);
        setProgress("");
      }
      await refresh(scope);
      // The watcher also sees our own writes; the refresh above already covered them.
      lastActEnd.current = Date.now();
      return ok;
    },
    [refresh, report, toast],
  );

  const gitOp = (label: string, op: GitOp, opts?: ActOptions) =>
    act(label, "all", (id) => runGitOp(id, op, setProgress), opts);

  /** Outside changes (an editor, a terminal, another git client) refresh what moved, quietly. */
  onChangedRef.current = (c) => {
    const info = repoRef.current;
    if (!info || busyRef.current || Date.now() - lastActEnd.current < 700) return;
    if (c.refs) void refresh("all");
    else if (c.worktree) void loadStatus(info);
  };

  const startWatching = (info: RepoInfo) => {
    if (watchId.current !== null) void unwatchRepo(watchId.current);
    watchId.current = watchRepo(info.id, (c) => onChangedRef.current(c));
  };

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
    const commit: Endpoint = { type: "commit", oid: row.oid, summary: row.summary };
    if (s.kind === "commit") return commit;

    // The green HEAD badge stands for the checked-out branch, or for the commit if detached.
    const name = s.name === "HEAD" ? (status?.branch ?? null) : s.name;
    const ref = name ? refs.find((r) => r.name === name) : undefined;
    if (!ref) return commit;
    return { type: "ref", name: ref.name, kind: ref.kind, oid: ref.target, isHead: ref.is_head };
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

  const onMenu = (subject: Subject, x: number, y: number) => {
    const e = endpointFor(subject);
    if (!e || busy) return;
    setMenu({ x, y, actions: menuActions(e, currentHead()) });
  };

  const onRefMenu = (ref: RefInfo, x: number, y: number) => {
    if (busy) return;
    const e: Endpoint = { type: "ref", name: ref.name, kind: ref.kind, oid: ref.target, isHead: ref.is_head };
    setMenu({ x, y, actions: menuActions(e, currentHead()) });
  };

  // ---- Opening and closing repositories ----

  const adopt = async (picked: RepoInfo) => {
    const previous = repoRef.current;
    if (previous && previous.id !== picked.id) await closeRepo(previous.id);
    repoRef.current = picked;
    wasInOperation.current = false;
    setRepo(picked);
    startWatching(picked);
    setRefs([]);
    setStatus(null);
    setDiff(null);
    setSelected(null);
    setTab("commit");
    void loadGraph(picked);
    void loadRefs(picked);
    void loadStatus(picked);
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

  const closeCurrent = async () => {
    const info = repoRef.current;
    if (!info) return;
    if (streamId.current !== null) await cancelStream(streamId.current);
    repoRef.current = null;
    if (watchId.current !== null) void unwatchRepo(watchId.current);
    watchId.current = null;
    setRepo(null);
    setRefs([]);
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

  const overlayOpen = paletteOpen || shortcutsOpen || profilesOpen || newBranchOpen || !!confirm || !!menu;
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
    if (repo) {
      add({ id: "fetch", title: "Fetch", group: "Actions", icon: RefreshCw, run: () => void gitOp("Fetching…", { op: "fetch" }, { done: "Fetch complete", fail: "Fetch failed" }) });
      if (status?.upstream)
        add({ id: "pull", title: "Pull", group: "Actions", icon: ArrowDownToLine, run: () => void gitOp("Pulling…", { op: "pull" }, { done: "Pulled", fail: "Pull failed" }) });
      if (status?.branch)
        add({
          id: "push",
          title: publish ? "Publish branch" : "Push",
          group: "Actions",
          icon: ArrowUpFromLine,
          run: () => void gitOp(publish ? "Publishing…" : "Pushing…", { op: "push", set_upstream: publish }, { done: publish ? "Published" : "Pushed", fail: "Push failed" }),
        });
      add({ id: "refresh", title: "Refresh", group: "Actions", icon: History, shortcut: "F5", run: () => void refresh("all") });
      add({ id: "newbranch", title: "New branch…", group: "Actions", icon: GitBranchPlus, run: () => setNewBranchOpen(true) });
      add({ id: "sidebar", title: sidebarOpen ? "Hide sidebar" : "Show sidebar", group: "Actions", icon: PanelLeft, shortcut: "Ctrl+B", run: () => setSidebarOpen((o) => !o) });
      add({ id: "close", title: "Close repository", group: "Actions", icon: X, run: () => void closeCurrent() });
    }
    add({ id: "theme-light", title: "Theme: Light", group: "Actions", icon: Sun, run: () => setTheme("light") });
    add({ id: "theme-dark", title: "Theme: Dark", group: "Actions", icon: Moon, run: () => setTheme("dark") });
    add({ id: "theme-system", title: "Theme: Follow system", group: "Actions", icon: Sun, run: () => setTheme("system") });
    add({ id: "profiles", title: "Manage profiles…", group: "Actions", icon: Users, run: () => setProfilesOpen(true) });
    add({ id: "shortcuts", title: "Keyboard shortcuts", group: "Actions", icon: Keyboard, shortcut: "?", run: () => setShortcutsOpen(true) });

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
  }, [repo, status, refs, profiles, recents, sidebarOpen, busy]);

  const menuItems = (actions: GraphAction[]): MenuItem[] =>
    actions.map((a) => ({ id: a.id, label: a.title, danger: a.danger }));

  const changeCount = status?.entries.length ?? 0;
  const publish = !!status?.branch && !status.upstream;
  const maxDiffH = Math.max(160, window.innerHeight - 280);

  return (
    <div className="app">
      <Toolbar
        repo={repo}
        status={status}
        busy={!!busy}
        loading={loading}
        recents={recents}
        profiles={profiles}
        sidebarOpen={sidebarOpen}
        theme={theme}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onOpen={() => void open()}
        onOpenRecent={(p) => void openRecent(p)}
        onCloseRepo={() => void closeCurrent()}
        onFetch={() => void gitOp("Fetching…", { op: "fetch" }, { done: "Fetch complete", fail: "Fetch failed" })}
        onPull={() => void gitOp("Pulling…", { op: "pull" }, { done: "Pulled", fail: "Pull failed" })}
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
        onTheme={setTheme}
        onShortcuts={() => setShortcutsOpen(true)}
      />

      {repo ? (
        <div className="workspace">
          {sidebarOpen && (
            <>
              <aside className="pane pane-side" style={{ width: sidebarW }}>
                <Sidebar
                  refs={refs}
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
                onMenu={onMenu}
                labelFor={labelFor}
                wip={wip}
                headRow={headRow}
                headBranch={status?.branch ?? null}
                refKinds={refKinds}
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
                  <DiffView repoId={repo.id} target={diff} version={diffVersion} onClose={() => setDiff(null)} />
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
                />
              ) : (
                <ChangesPanel
                  status={status}
                  busy={!!busy}
                  activeDiff={diff}
                  identity={identity}
                  onOpenDiff={setDiff}
                  onStage={(paths) => void act("Staging…", "status", (id) => stagePaths(id, paths), { fail: "Could not stage" })}
                  onUnstage={(paths) =>
                    void act("Unstaging…", "status", (id) => unstagePaths(id, paths), { fail: "Could not unstage" })
                  }
                  onCommit={(message, amend) =>
                    act(amend ? "Amending…" : "Committing…", "all", (id) => createCommit(id, message, amend), {
                      done: amend ? "Amended the last commit" : "Committed",
                      fail: "Commit failed",
                    })
                  }
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
        />
      )}

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
        />
      )}
      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} onGotoCommit={gotoCommit} />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
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
