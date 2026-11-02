import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, GitCommitVertical, Search } from "lucide-react";
import { fuzzyMatch } from "./lib/fuzzy";
import { Dialog, EmptyState, Shortcut } from "./ui";

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface PaletteItem {
  id: string;
  title: string;
  /** Dimmed text after the title (a path, an email…). */
  subtitle?: string;
  group: string;
  icon?: IconType;
  shortcut?: string;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
  /** Called when the query looks like a commit id and the user chooses "Go to commit". */
  onGotoCommit: (prefix: string) => void;
}

const GROUP_ORDER = ["Actions", "Branches", "Profiles", "Repositories", "Commits"];
const MAX_RESULTS = 60;

function Marked({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  );
}

export function CommandPalette({ items, onClose, onGotoCommit }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const q = query.trim();
    const hash = /^[0-9a-f]{4,40}$/i.test(q);
    const scored = items
      .map((item) => {
        const t = fuzzyMatch(q, item.title);
        const s = item.subtitle ? fuzzyMatch(q, item.subtitle) : null;
        if (!t && !s) return null;
        // Title matches count fully; a subtitle-only match ranks lower and is not highlighted.
        const score = t ? t.score : (s?.score ?? 0) - 40;
        return { item, score, positions: t?.positions ?? [] };
      })
      .filter((x): x is { item: PaletteItem; score: number; positions: number[] } => x !== null);

    if (q) scored.sort((a, b) => b.score - a.score);
    else
      scored.sort(
        (a, b) =>
          GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group),
      );

    const rows = scored.slice(0, MAX_RESULTS);
    if (hash) {
      rows.unshift({
        item: {
          id: "goto-commit",
          title: `Go to commit ${q.toLowerCase()}`,
          group: "Commits",
          icon: GitCommitVertical,
          run: () => onGotoCommit(q),
        },
        score: Infinity,
        positions: [],
      });
    }
    return rows;
  }, [items, query, onGotoCommit]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const row = results[i];
    if (!row) return;
    onClose();
    // Let the dialog hand focus back first, so actions that open other dialogs keep theirs.
    setTimeout(row.item.run, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(results.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(Math.max(0, results.length - 1));
    else if (e.key === "Enter") choose(active);
    else return;
    e.preventDefault();
  };

  let lastGroup = "";
  return (
    <Dialog title="Command palette" onClose={onClose} width={620} top bare>
      <div className="palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, branch, repository, or commit id…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {results.length === 0 ? (
          <EmptyState icon={Search} title="No matches" hint="Try a shorter search." />
        ) : (
          <ul id="palette-list" ref={listRef} className="palette-list" role="listbox">
            {results.map(({ item, positions }, i) => {
              const header = item.group !== lastGroup;
              lastGroup = item.group;
              const Icon = item.icon;
              return (
                <li key={item.id} role="presentation">
                  {header && !query.trim() && <div className="palette-group">{item.group}</div>}
                  <button
                    id={`palette-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "palette-item active" : "palette-item"}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(i)}
                  >
                    <span className="palette-icon">{Icon && <Icon size={15} />}</span>
                    <span className="palette-title">
                      <Marked text={item.title} positions={positions} />
                    </span>
                    {item.subtitle && <span className="palette-sub">{item.subtitle}</span>}
                    {query.trim() && <span className="palette-group-tag">{item.group}</span>}
                    {item.shortcut && <Shortcut keys={item.shortcut} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="palette-foot">
          <span>
            <Shortcut keys="↑" /> <Shortcut keys="↓" /> to move
          </span>
          <span>
            <CornerDownLeft size={12} /> to run
          </span>
          <span>
            <Shortcut keys="Esc" /> to close
          </span>
        </div>
      </div>
    </Dialog>
  );
}
