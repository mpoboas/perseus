import { useState } from "react";
import { ArrowDown, ArrowUp, GitCommitVertical, X } from "lucide-react";
import { shortSha } from "./lib/format";
import { Button, Dialog, IconButton } from "./ui";

export interface PickCommit {
  oid: string;
  summary: string;
  author: string;
  /** Merge commits cannot be cherry-picked as they are. */
  merge: boolean;
}

interface Props {
  /** The chosen commits, oldest first: the order they will be applied in. */
  commits: PickCommit[];
  /** Where they land: the checked-out branch, or a description of a detached HEAD. */
  target: string;
  onRun: (oids: string[], squash: string | null) => void;
  onClose: () => void;
}

/** Picks several commits onto the checked-out branch: reorder, leave some out, or combine them into one. */
export function CherryPickDialog({ commits, target, onRun, onClose }: Props) {
  const skipped = commits.filter((c) => c.merge);
  const [order, setOrder] = useState(() => commits.filter((c) => !c.merge));
  const [combine, setCombine] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);

  // Until the user writes their own, the combined message is just the summaries, one per line.
  const message = edited ?? order.map((c) => c.summary).join("\n");

  const move = (i: number, by: number) =>
    setOrder((list) => {
      const next = [...list];
      const j = i + by;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const count = order.length;
  const ready = count > 0 && (!combine || message.trim().length > 0);

  return (
    <Dialog
      title={`Cherry-pick ${commits.length} commits`}
      width={560}
      onClose={onClose}
      onSubmit={() => ready && onRun(order.map((c) => c.oid), combine ? message.trim() : null)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitCommitVertical} disabled={!ready}>
            {combine ? "Cherry-pick into one commit" : `Cherry-pick ${count} commit${count === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Copies these commits onto <strong>{target}</strong>, top to bottom. Use the arrows to change the
          order. If one of them conflicts, the pick stops there so you can resolve it and continue.
        </p>
        <ol className="pick-list" aria-label="Commits to cherry-pick">
          {order.map((c, i) => (
            <li key={c.oid} className="pick-item">
              <span className="pick-n">{i + 1}</span>
              <span className="pick-sha">{shortSha(c.oid)}</span>
              <span className="pick-summary" title={c.summary}>
                {c.summary}
              </span>
              <span className="pick-by">{c.author}</span>
              <span className="pick-tools">
                <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={i === count - 1} onClick={() => move(i, 1)} />
                <IconButton
                  icon={X}
                  label="Leave this commit out"
                  size="sm"
                  onClick={() => setOrder((list) => list.filter((x) => x.oid !== c.oid))}
                />
              </span>
            </li>
          ))}
          {count === 0 && <li className="pick-empty">Nothing left to pick.</li>}
        </ol>
        {skipped.length > 0 && (
          <p className="muted small">
            {skipped.length === 1 ? "A merge commit was" : `${skipped.length} merge commits were`} left out
            ({skipped.map((c) => shortSha(c.oid)).join(", ")}): pick the commits they merged instead.
          </p>
        )}
        <label className="check-row">
          <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} /> Combine them into
          a single commit
        </label>
        {combine && (
          <div className="field">
            <label htmlFor="pick-message">Commit message</label>
            <textarea
              id="pick-message"
              className="textarea pick-message"
              rows={Math.min(8, Math.max(3, order.length + 1))}
              value={message}
              onChange={(e) => setEdited(e.target.value)}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
