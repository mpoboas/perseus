import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { type PlanCommit, type TodoAction, type TodoItem, rebasePlan } from "./ipc";
import { shortSha } from "./lib/format";
import { Badge, Button, Dialog, EmptyState, IconButton, Skeleton } from "./ui";

interface Props {
  repoId: number;
  /** Commit the rebase is based on: everything after it is listed. */
  base: string;
  baseLabel: string;
  onStart: (items: TodoItem[]) => void;
  onClose: () => void;
}

const ACTIONS: { value: TodoAction; label: string; help: string }[] = [
  { value: "pick", label: "Pick", help: "Keep the commit as it is" },
  { value: "reword", label: "Reword", help: "Keep the changes, write a new message" },
  { value: "edit", label: "Edit", help: "Stop here so you can change the commit" },
  { value: "squash", label: "Squash", help: "Meld into the commit above, combining both messages" },
  { value: "fixup", label: "Fixup", help: "Meld into the commit above, discarding this message" },
  { value: "drop", label: "Drop", help: "Remove the commit" },
];

interface Row extends PlanCommit {
  action: TodoAction;
  message: string;
}

export function RebaseDialog({ repoId, base, baseLabel, onStart, onClose }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState<string[]>([]);

  useEffect(() => {
    rebasePlan(repoId, base).then(
      // The plan is oldest first, as git replays it; the table shows newest first like the graph.
      (plan) => {
        setRows(plan.map((c) => ({ ...c, action: "pick" as TodoAction, message: c.summary })).reverse());
        setOriginal(plan.map((c) => c.oid).reverse());
      },
      (e) => setError(String(e)),
    );
  }, [repoId, base]);

  const move = (i: number, by: -1 | 1) =>
    setRows((r) => {
      if (!r) return r;
      const j = i + by;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const set = (i: number, patch: Partial<Row>) => setRows((r) => r?.map((x, k) => (k === i ? { ...x, ...patch } : x)) ?? r);

  // Oldest first again, as git wants it.
  const ordered = rows ? [...rows].reverse() : [];
  const firstKept = ordered.find((r) => r.action !== "drop");
  const problem =
    ordered.length === 0
      ? null
      : !firstKept
        ? "Every commit is dropped; nothing would be left."
        : firstKept.action === "squash" || firstKept.action === "fixup"
          ? "The oldest remaining commit cannot be squashed into anything."
          : ordered.some((r) => r.action === "reword" && !r.message.trim())
            ? "A reworded commit needs a message."
            : null;
  const changed = rows?.some((r, i) => r.action !== "pick" || r.oid !== original[i]) ?? false;
  const hasMerges = rows?.some((r) => r.is_merge) ?? false;

  const start = () =>
    onStart(
      ordered.map((r) => ({
        action: r.action,
        oid: r.oid,
        message: r.action === "reword" ? r.message : null,
      })),
    );

  return (
    <Dialog
      title="Interactive rebase"
      width={860}
      onClose={onClose}
      footer={
        <>
          <span className="muted small grow">
            {problem ?? `Rewrites the commits after ${baseLabel}. New ids are created.`}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!!problem || !rows || rows.length === 0} onClick={start}>
            {changed ? "Rebase" : "Rebase (no changes)"}
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        {error ? (
          <EmptyState title="Could not plan the rebase" hint={error} />
        ) : !rows ? (
          <Skeleton height={80} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing to rebase" hint="There are no commits after the chosen one on this branch." />
        ) : (
          <>
            {hasMerges && (
              <div className="callout callout-warn">
                <TriangleAlert size={16} />
                <p>
                  This range contains merge commits. An interactive rebase flattens them: their changes are replayed as plain
                  commits and the merge structure is lost.
                </p>
              </div>
            )}
            <p className="muted small">
              Newest first, as in the graph. Choose what happens to each commit and use the arrows to reorder. Replaying
              runs oldest to newest.
            </p>
            <ul className="rebase-list">
              {rows.map((r, i) => (
                <li key={r.oid} className={r.action === "drop" ? "rebase-row dropped" : "rebase-row"}>
                  <div className="rebase-main">
                    <select
                      className="select rebase-action"
                      aria-label={`Action for ${r.summary}`}
                      value={r.action}
                      onChange={(e) => set(i, { action: e.target.value as TodoAction })}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a.value} value={a.value} title={a.help}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <code>{shortSha(r.oid)}</code>
                    <span className="rebase-summary">{r.summary}</span>
                    {r.is_merge && <Badge tone="warn">merge</Badge>}
                    <IconButton icon={ArrowUp} label="Move newer" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton icon={ArrowDown} label="Move older" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
                  </div>
                  {r.action === "reword" && (
                    <textarea
                      className="textarea"
                      aria-label={`New message for ${r.summary}`}
                      rows={3}
                      value={r.message}
                      onChange={(e) => set(i, { message: e.target.value })}
                    />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
