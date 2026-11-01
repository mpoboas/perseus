import { useState } from "react";
import type { DiffTarget, RepoStatus, StatusEntry, WorkSide } from "./ipc";

interface Props {
  status: RepoStatus | null;
  busy: boolean;
  activeDiff: DiffTarget | null;
  /** "Name <email>" of the active profile, or null to use git's own configuration. */
  identity: string | null;
  onOpenDiff: (t: DiffTarget) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string, amend: boolean) => Promise<boolean>;
  onContinue: () => void;
  onAbort: () => void;
}

const OPERATION_LABEL = {
  merge: "Merge",
  cherry_pick: "Cherry-pick",
  rebase: "Rebase",
  revert: "Revert",
} as const;

function paths(e: StatusEntry): string[] {
  return e.orig_path ? [e.path, e.orig_path] : [e.path];
}

interface RowProps {
  entry: StatusEntry;
  code: string;
  active: boolean;
  action: { label: string; title: string; run: () => void };
  onOpen: () => void;
}

function Row({ entry, code, active, action, onOpen }: RowProps) {
  return (
    <li className={active ? "change active" : "change"}>
      <span className={`st st-${code}`}>{code}</span>
      <button className="path" onClick={onOpen} title={entry.path}>
        {entry.orig_path ? `${entry.orig_path} → ${entry.path}` : entry.path}
      </button>
      <button className="mini" title={action.title} onClick={action.run}>
        {action.label}
      </button>
    </li>
  );
}

export function ChangesPanel({
  status,
  busy,
  activeDiff,
  identity,
  onOpenDiff,
  onStage,
  onUnstage,
  onCommit,
  onContinue,
  onAbort,
}: Props) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);

  if (!status) return <aside className="detail empty">Open a repository</aside>;

  const conflicted = status.entries.filter((e) => e.conflicted);
  const staged = status.entries.filter((e) => !e.conflicted && e.index);
  const unstaged = status.entries.filter((e) => !e.conflicted && !e.untracked && e.worktree);
  const untracked = status.entries.filter((e) => e.untracked);
  const isActive = (side: WorkSide, e: StatusEntry) =>
    activeDiff?.kind === "work" && activeDiff.side === side && activeDiff.path === e.path;

  const canCommit =
    !busy && message.trim().length > 0 && (staged.length > 0 || amend) && conflicted.length === 0;

  const submit = async () => {
    if (!canCommit) return;
    if (await onCommit(message, amend)) {
      setMessage("");
      setAmend(false);
    }
  };

  const section = (
    title: string,
    entries: StatusEntry[],
    side: WorkSide,
    code: (e: StatusEntry) => string,
    action: { label: string; title: string; run: (e: StatusEntry) => void },
    bulk?: { label: string; run: () => void },
  ) =>
    entries.length > 0 && (
      <section>
        <h3>
          {title} <span className="count">{entries.length}</span>
          {bulk && (
            <button className="mini bulk" disabled={busy} onClick={bulk.run}>
              {bulk.label}
            </button>
          )}
        </h3>
        <ul>
          {entries.map((e) => (
            <Row
              key={`${side}:${e.path}`}
              entry={e}
              code={code(e)}
              active={isActive(side, e)}
              action={{ ...action, run: () => action.run(e) }}
              onOpen={() =>
                onOpenDiff({ kind: "work", side, path: e.path, orig: side === "staged" ? e.orig_path : null })
              }
            />
          ))}
        </ul>
      </section>
    );

  return (
    <aside className="detail changes">
      {status.operation && (
        <div className="banner">
          <strong>{OPERATION_LABEL[status.operation]} in progress</strong>
          {conflicted.length > 0 ? (
            <span> — resolve {conflicted.length} conflicted file(s), stage them, then continue</span>
          ) : (
            <span> — ready to continue</span>
          )}
          <div className="banner-actions">
            <button disabled={busy || conflicted.length > 0} onClick={onContinue}>
              Continue
            </button>
            <button disabled={busy} onClick={onAbort}>
              Abort
            </button>
          </div>
        </div>
      )}

      {status.entries.length === 0 && !status.operation && (
        <p className="muted">Working tree clean</p>
      )}

      {section(
        "Conflicts",
        conflicted,
        "unstaged",
        () => "U",
        { label: "✓", title: "Mark resolved (stage)", run: (e) => onStage([e.path]) },
      )}
      {section(
        "Staged",
        staged,
        "staged",
        (e) => e.index ?? "?",
        { label: "−", title: "Unstage", run: (e) => onUnstage(paths(e)) },
        { label: "Unstage all", run: () => onUnstage(staged.flatMap(paths)) },
      )}
      {section(
        "Changes",
        unstaged,
        "unstaged",
        (e) => e.worktree ?? "?",
        { label: "+", title: "Stage", run: (e) => onStage([e.path]) },
        { label: "Stage all", run: () => onStage(unstaged.map((e) => e.path)) },
      )}
      {section(
        "Untracked",
        untracked,
        "untracked",
        () => "?",
        { label: "+", title: "Stage", run: (e) => onStage([e.path]) },
        { label: "Stage all", run: () => onStage(untracked.map((e) => e.path)) },
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="identity muted" title="Change the active profile in the toolbar">
          Committing as {identity ?? "your Git default identity"}
        </p>
        <textarea
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={message}
          rows={4}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-row">
          <label>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />{" "}
            Amend last commit
          </label>
          <button type="submit" disabled={!canCommit}>
            {amend ? "Amend" : "Commit"}
            {status.branch ? ` to ${status.branch}` : ""}
          </button>
        </div>
      </form>
    </aside>
  );
}
