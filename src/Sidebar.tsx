import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  Folder,
  GitBranch,
  Archive,
  Plus,
  Search,
  Tag,
  TriangleAlert,
  X,
} from "lucide-react";
import type { RefInfo, StashEntry } from "./ipc";
import { relativeTime } from "./lib/format";
import { fuzzyMatch } from "./lib/fuzzy";
import { usePref } from "./lib/prefs";
import { type RefNode, buildRefTree } from "./lib/refTree";
import { EmptyState, IconButton, Tooltip } from "./ui";

interface Props {
  refs: RefInfo[];
  stashes: StashEntry[];
  /** Refs left out of the graph, and refs the graph is limited to. */
  hidden: ReadonlySet<string>;
  solo: ReadonlySet<string>;
  onStashMenu: (entry: StashEntry, x: number, y: number) => void;
  busy: boolean;
  onJump: (target: string) => void;
  onCheckout: (ref: RefInfo) => void;
  onCreateBranch: (name: string) => void;
  onMenu: (ref: RefInfo, x: number, y: number) => void;
}

const SECTIONS: { kind: RefInfo["kind"]; id: string; title: string; icon: typeof GitBranch }[] = [
  { kind: "branch", id: "local", title: "Local", icon: GitBranch },
  { kind: "remote", id: "remote", title: "Remote", icon: Cloud },
  { kind: "tag", id: "tags", title: "Tags", icon: Tag },
];

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const at = new Set(positions);
  const parts: React.ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number) => {
    if (run) parts.push(marked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  [...text].forEach((ch, i) => {
    const m = at.has(i);
    if (m !== marked) {
      flush(i);
      marked = m;
    }
    run += ch;
  });
  flush(text.length);
  return <>{parts}</>;
}

export function Sidebar({ refs, stashes, hidden, solo, onStashMenu, busy, onJump, onCheckout, onCreateBranch, onMenu }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = usePref<Record<string, boolean>>("sidebar.collapsed", {});

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreateBranch(n);
    setName("");
    setCreating(false);
  };

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const filtering = filter.trim().length > 0;

  return (
    <nav className="sidebar" aria-label="References">
      <div className="sidebar-tools">
        <div className="input-wrap has-icon">
          <Search size={14} />
          <input
            className="input"
            value={filter}
            placeholder="Filter branches and tags"
            aria-label="Filter references"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
        </div>
        <IconButton icon={Plus} label="New branch" disabled={busy} onClick={() => setCreating(true)} />
      </div>

      {creating && (
        <form
          className="sidebar-create"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            className="input"
            value={name}
            placeholder="new-branch-name"
            aria-label="New branch name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            onBlur={() => !name.trim() && setCreating(false)}
          />
          <IconButton icon={Check} label="Create and check out" type="submit" size="sm" disabled={!name.trim()} />
        </form>
      )}

      <div className="sidebar-scroll">
        {refs.length === 0 && <EmptyState icon={GitBranch} title="No references" hint="Branches and tags appear here." />}
        {SECTIONS.map(({ kind, id, title, icon: Icon }) => {
          const all = refs.filter((r) => r.kind === kind);
          if (all.length === 0) return null;
          const matches = filtering
            ? all
                .map((r) => ({ r, m: fuzzyMatch(filter, r.name) }))
                .filter((x): x is { r: RefInfo; m: NonNullable<typeof x.m> } => x.m !== null)
                .sort((a, b) => b.m.score - a.m.score)
            : [];
          if (filtering && matches.length === 0) return null;
          const open = filtering || !collapsed[id];
          return (
            <section key={id} className="side-section">
              <button className="side-head" aria-expanded={open} onClick={() => toggle(id)}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Icon size={14} />
                <span>{title}</span>
                <span className="side-count">{filtering ? matches.length : all.length}</span>
              </button>
              {open &&
                (filtering ? (
                  <ul>
                    {matches.map(({ r, m }) => (
                      <RefRow
                        key={r.name}
                        state={hidden.has(r.name) ? "hidden" : solo.has(r.name) ? "solo" : undefined}
                        info={r}
                        label={<Highlight text={r.name} positions={m.positions} />}
                        depth={0}
                        onJump={onJump}
                        onCheckout={onCheckout}
                        onMenu={onMenu}
                      />
                    ))}
                  </ul>
                ) : (
                  <Tree
                    nodes={buildRefTree(all)}
                    hidden={hidden}
                    solo={solo}
                    depth={0}
                    sectionId={id}
                    collapsed={collapsed}
                    toggle={toggle}
                    onJump={onJump}
                    onCheckout={onCheckout}
                    onMenu={onMenu}
                  />
                ))}
            </section>
          );
        })}
        {stashes.length > 0 && !filtering && (
          <section className="side-section">
            <button className="side-head" aria-expanded={!collapsed.stashes} onClick={() => toggle("stashes")}>
              {collapsed.stashes ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Archive size={14} />
              <span>Stashes</span>
              <span className="side-count">{stashes.length}</span>
            </button>
            {!collapsed.stashes && (
              <ul>
                {stashes.map((s) => (
                  <li key={s.index}>
                    <button
                      className="side-row"
                      style={{ paddingLeft: 28 }}
                      title="Right-click to apply, pop or drop"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onStashMenu(s, e.clientX, e.clientY);
                      }}
                      onDoubleClick={(e) => onStashMenu(s, e.clientX, e.clientY)}
                    >
                      <Archive size={13} className="side-icon" />
                      <span className="side-label">{s.message.replace(/^(WIP on|On) [^:]+: /, "")}</span>
                      <span className="side-count">{relativeTime(s.time)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {filtering && !SECTIONS.some((s) => refs.some((r) => r.kind === s.kind && fuzzyMatch(filter, r.name))) && (
          <EmptyState icon={Search} title="No matches" hint={`Nothing is named like “${filter.trim()}”.`}>
            <button className="link-btn" onClick={() => setFilter("")}>
              <X size={12} /> Clear filter
            </button>
          </EmptyState>
        )}
      </div>
    </nav>
  );
}

interface TreeProps {
  nodes: RefNode<RefInfo>[];
  hidden: ReadonlySet<string>;
  solo: ReadonlySet<string>;
  depth: number;
  sectionId: string;
  collapsed: Record<string, boolean>;
  toggle: (id: string) => void;
  onJump: Props["onJump"];
  onCheckout: Props["onCheckout"];
  onMenu: Props["onMenu"];
}

function Tree({ nodes, hidden, solo, depth, sectionId, collapsed, toggle, ...rest }: TreeProps) {
  return (
    <ul>
      {nodes.map((n) => {
        if (n.type === "leaf") {
          const state = hidden.has(n.name) ? "hidden" : solo.has(n.name) ? "solo" : undefined;
          return <RefRow key={n.name} info={n.item} label={n.label} depth={depth} state={state} {...rest} />;
        }
        const id = `${sectionId}:${n.path}`;
        const open = !collapsed[id];
        return (
          <li key={id}>
            <button
              className="side-row side-folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              aria-expanded={open}
              onClick={() => toggle(id)}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Folder size={13} />
              <span className="side-label">{n.label}</span>
              <span className="side-count">{n.count}</span>
            </button>
            {open && (
              <Tree nodes={n.children} hidden={hidden} solo={solo} depth={depth + 1} sectionId={sectionId} collapsed={collapsed} toggle={toggle} {...rest} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** How the graph treats a ref: left out ("hidden") or the only one shown ("solo"). */
interface RowProps {
  state?: "hidden" | "solo";
  info: RefInfo;
  label: React.ReactNode;
  depth: number;
  onJump: Props["onJump"];
  onCheckout: Props["onCheckout"];
  onMenu: Props["onMenu"];
}

function RefRow({ state, info, label, depth, onJump, onCheckout, onMenu }: RowProps) {
  const Icon = info.kind === "tag" ? Tag : info.kind === "remote" ? Cloud : GitBranch;
  const hint =
    info.kind === "tag" ? info.name : `${info.name} — double-click to check out, right-click for more`;
  return (
    <li>
      <Tooltip label={hint} side="top">
        <button
          className={`side-row${info.is_head ? " head" : ""}${state === "hidden" ? " hidden-ref" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 + 18 }}
          onClick={() => onJump(info.target)}
          onDoubleClick={() => info.kind !== "tag" && onCheckout(info)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(info, e.clientX, e.clientY);
          }}
        >
          <Icon size={13} className="side-icon" />
          <span className="side-label">{label}</span>
          {state === "hidden" && <EyeOff size={12} className="side-icon" aria-label="Hidden in the graph" />}
          {state === "solo" && <Eye size={12} className="side-check" aria-label="Shown alone in the graph" />}
          {info.gone && (
            <span className="side-gone" title="The upstream branch no longer exists on the remote">
              <TriangleAlert size={12} /> gone
            </span>
          )}
          {info.ahead > 0 && (
            <span className="side-ab ahead" title={`${info.ahead} commit(s) to push`}>
              <ArrowUp size={11} />
              {info.ahead}
            </span>
          )}
          {info.behind > 0 && (
            <span className="side-ab behind" title={`${info.behind} commit(s) to pull`}>
              <ArrowDown size={11} />
              {info.behind}
            </span>
          )}
          {info.is_head && <Check size={13} className="side-check" aria-label="Checked out" />}
        </button>
      </Tooltip>
    </li>
  );
}
