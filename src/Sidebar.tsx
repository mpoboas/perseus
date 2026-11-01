import type { RefInfo } from "./ipc";

interface Props {
  refs: RefInfo[];
  onJump: (target: string) => void;
}

const GROUPS: { kind: RefInfo["kind"]; title: string }[] = [
  { kind: "branch", title: "Branches" },
  { kind: "remote", title: "Remotes" },
  { kind: "tag", title: "Tags" },
];

export function Sidebar({ refs, onJump }: Props) {
  return (
    <nav className="sidebar" aria-label="References">
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
                    title={r.name}
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
