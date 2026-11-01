import { useState } from "react";
import type { RefInfo } from "./ipc";

interface Props {
  refs: RefInfo[];
  busy: boolean;
  onJump: (target: string) => void;
  onCheckout: (ref: RefInfo) => void;
  onCreateBranch: (name: string) => void;
}

const GROUPS: { kind: RefInfo["kind"]; title: string }[] = [
  { kind: "branch", title: "Branches" },
  { kind: "remote", title: "Remotes" },
  { kind: "tag", title: "Tags" },
];

export function Sidebar({ refs, busy, onJump, onCheckout, onCreateBranch }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreateBranch(n);
    setName("");
    setCreating(false);
  };

  return (
    <nav className="sidebar" aria-label="References">
      <div className="sidebar-actions">
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={name}
              placeholder="new-branch-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            />
          </form>
        ) : (
          <button className="mini" disabled={busy} onClick={() => setCreating(true)}>
            + New branch
          </button>
        )}
      </div>
      {GROUPS.map(({ kind, title }) => {
        const items = refs.filter((r) => r.kind === kind);
        if (items.length === 0) return null;
        return (
          <section key={kind}>
            <h2>
              {title} <span className="count">{items.length}</span>
            </h2>
            <ul>
              {items.map((r) => (
                <li key={r.name}>
                  <button
                    className={r.is_head ? "ref-item head" : "ref-item"}
                    onClick={() => onJump(r.target)}
                    onDoubleClick={() => r.kind !== "tag" && onCheckout(r)}
                    title={r.kind === "tag" ? r.name : `${r.name} — double-click to check out`}
                  >
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
