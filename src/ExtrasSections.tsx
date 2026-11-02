import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileStack, FolderGit2, GitFork, GitMerge, Package, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type FlowKind, type FlowStatus, type LfsStatus, type Submodule, type Worktree, flowStatus, lfsStatus, lfsTrack, listSubmodules, listWorktrees } from "./ipc";
import { usePref } from "./lib/prefs";
import { IconButton } from "./ui";

interface Props {
  repoId: number;
  /** Changes whenever the repository is reloaded, so these lists follow along. */
  version: unknown;
  busy: boolean;
  /** Opens a submodule (relative path) or worktree (absolute path) as its own repository. */
  onOpen: (path: string) => void;
  onUpdateSubmodules: (path: string | null) => void;
  onAddSubmodule: () => void;
  onFlowStart: (kind: FlowKind) => void;
  onFlowFinish: (kind: FlowKind, name: string) => void;
  onRemoveWorktree: (w: Worktree) => void;
  onTrackLfs: (pattern: string) => void;
}

const STATE_HINT: Record<Submodule["state"], string> = {
  clean: "",
  uninitialized: "Not downloaded yet",
  modified: "Checked out at a different commit than the project records",
  conflicted: "Has a merge conflict",
};

/** Submodules, linked worktrees and Git LFS: shown only for repositories that use them. */
export function ExtrasSections({ repoId, version, busy, onOpen, onUpdateSubmodules, onAddSubmodule, onFlowStart, onFlowFinish, onRemoveWorktree, onTrackLfs }: Props) {
  const [submodules, setSubmodules] = useState<Submodule[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [lfs, setLfs] = useState<LfsStatus | null>(null);
  const [flow, setFlow] = useState<FlowStatus | null>(null);
  const [pattern, setPattern] = useState("");
  const [collapsed, setCollapsed] = usePref<Record<string, boolean>>("sidebar.extras.collapsed", {});

  useEffect(() => {
    let live = true;
    void Promise.allSettled([listSubmodules(repoId), listWorktrees(repoId), lfsStatus(repoId), flowStatus(repoId)]).then(([s, w, l, f]) => {
      if (!live) return;
      setSubmodules(s.status === "fulfilled" ? s.value : []);
      setWorktrees(w.status === "fulfilled" ? w.value : []);
      setLfs(l.status === "fulfilled" ? l.value : null);
      setFlow(f.status === "fulfilled" ? f.value : null);
    });
    return () => {
      live = false;
    };
  }, [repoId, version]);

  const toggle = useCallback((id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] })), [setCollapsed]);
  const head = (id: string, icon: React.ReactNode, title: string, count: number) => (
    <button className="side-head" aria-expanded={!collapsed[id]} onClick={() => toggle(id)}>
      {collapsed[id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      {icon}
      <span>{title}</span>
      <span className="side-count">{count}</span>
    </button>
  );

  const flowGroups: { kind: FlowKind; title: string; names: string[] }[] = flow?.initialized
    ? [
        { kind: "feature", title: "Features", names: flow.features },
        { kind: "release", title: "Releases", names: flow.releases },
        { kind: "hotfix", title: "Hotfixes", names: flow.hotfixes },
      ]
    : [];
  const showLfs = lfs !== null && (lfs.patterns.length > 0 || lfs.installed);
  return (
    <>
      {submodules.length > 0 && (
        <section className="side-section">
          {head("submodules", <Package size={14} />, "Submodules", submodules.length)}
          {!collapsed.submodules && (
            <ul>
              {submodules.map((s) => (
                <li key={s.path}>
                  <button
                    className="side-row"
                    style={{ paddingLeft: 28 }}
                    title={`${s.path} — ${STATE_HINT[s.state] || "up to date"}. Double-click to open.`}
                    disabled={s.state === "uninitialized"}
                    onDoubleClick={() => onOpen(s.path)}
                  >
                    <FolderGit2 size={13} className="side-icon" />
                    <span className="side-label">{s.path}</span>
                    {s.state !== "clean" && <span className={`side-state state-${s.state}`}>{s.state === "uninitialized" ? "not downloaded" : s.state}</span>}
                  </button>
                </li>
              ))}
              <li className="side-note">
                <button className="link-btn" disabled={busy} onClick={() => onUpdateSubmodules(null)}>
                  <RefreshCw size={12} /> Update all submodules
                </button>
              </li>
              <li className="side-note">
                <button className="link-btn" disabled={busy} onClick={onAddSubmodule}>
                  <Package size={12} /> Add a submodule…
                </button>
              </li>
            </ul>
          )}
        </section>
      )}
      {flow?.initialized && (
        <section className="side-section">
          {head("flow", <GitMerge size={14} />, "Gitflow", flow.features.length + flow.releases.length + flow.hotfixes.length)}
          {!collapsed.flow && (
            <ul>
              {flowGroups.map((g) => (
                <li key={g.kind} className="flow-group">
                  <div className="flow-head">
                    <span>{g.title}</span>
                    <IconButton icon={Plus} label={`Start a ${g.kind}`} size="sm" disabled={busy} onClick={() => onFlowStart(g.kind)} />
                  </div>
                  {g.names.map((n) => {
                    const here = flow.current?.kind === g.kind && flow.current.name === n;
                    return (
                      <div key={n} className="side-row-wrap">
                        <span className="side-row flow-name" style={{ paddingLeft: 28 }} title={here ? "Checked out" : undefined}>
                          {here ? <Check size={13} className="side-icon" /> : <GitMerge size={13} className="side-icon" />}
                          <span className="side-label">{n}</span>
                        </span>
                        <IconButton icon={GitMerge} label={`Finish ${g.kind} ${n}`} size="sm" className="row-action" disabled={busy} onClick={() => onFlowFinish(g.kind, n)} />
                      </div>
                    );
                  })}
                  {g.names.length === 0 && <div className="side-note">None</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {worktrees.length > 1 && (
        <section className="side-section">
          {head("worktrees", <GitFork size={14} />, "Worktrees", worktrees.length)}
          {!collapsed.worktrees && (
            <ul>
              {worktrees.map((w) => (
                <li key={w.path} className="side-row-wrap">
                  <button
                    className="side-row"
                    style={{ paddingLeft: 28 }}
                    title={`${w.path}${w.is_main ? " (this repository)" : " — double-click to open"}`}
                    disabled={w.is_main}
                    onDoubleClick={() => onOpen(w.path)}
                  >
                    <GitFork size={13} className="side-icon" />
                    <span className="side-label">{w.branch ?? `detached ${w.head.slice(0, 7)}`}</span>
                    {w.locked && <span className="side-state">locked</span>}
                  </button>
                  {!w.is_main && (
                    <IconButton icon={Trash2} label={`Remove worktree ${w.branch ?? w.path}`} size="sm" className="row-action" disabled={busy} onClick={() => onRemoveWorktree(w)} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {showLfs && (
        <section className="side-section">
          {head("lfs", <FileStack size={14} />, "Git LFS", lfs.patterns.length)}
          {!collapsed.lfs && (
            <ul>
              {lfs.patterns.map((p) => (
                <li key={p} className="side-note selectable">
                  {p}
                </li>
              ))}
              {lfs.patterns.length === 0 && <li className="side-note">Nothing is stored through LFS yet</li>}
              {lfs.installed ? (
                <li className="side-note">
                  <form
                    className="lfs-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!pattern.trim()) return;
                      onTrackLfs(pattern.trim());
                      setPattern("");
                    }}
                  >
                    <input className="input" aria-label="Pattern to track with LFS" placeholder="*.psd" value={pattern} onChange={(e) => setPattern(e.target.value)} />
                    <IconButton icon={RefreshCw} label="Track pattern" type="submit" size="sm" disabled={busy || !pattern.trim()} />
                  </form>
                </li>
              ) : (
                <li className="side-note">Git LFS is not installed on this computer</li>
              )}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

export { lfsTrack };
