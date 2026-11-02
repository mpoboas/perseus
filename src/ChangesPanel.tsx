import { useEffect, useRef, useState } from "react";
import { Archive, CheckCircle2, ChevronDown, ChevronRight, GitCommitHorizontal, GitMerge, ShieldAlert, Undo2 } from "lucide-react";
import { FileRow } from "./FileRow";
import type { DiffTarget, LineStats, RepoStatus, StatusEntry, WorkSide } from "./ipc";
import { usePref } from "./lib/prefs";
import { Avatar, Badge, Button, EmptyState, IconButton, Shortcut } from "./ui";

interface Props {
  status: RepoStatus | null;
  busy: boolean;
  activeDiff: DiffTarget | null;
  /** The active profile's identity, or null to use git's own configuration. */
  identity: { name: string; email: string } | null;
  onOpenDiff: (t: DiffTarget) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string, amend: boolean) => Promise<boolean>;
  onContinue: () => void;
  onAbort: () => void;
  /** Asks for confirmation, then throws the local changes of these paths away. */
  onDiscard: (paths: string[], untracked: boolean) => void;
  onStash: () => void;
  /** The last commit's message, to pre-fill the box when amending. */
  loadLastMessage: () => Promise<string | null>;
  /** The repository's commit template, if it has one. */
  loadTemplate: () => Promise<string | null>;
}

const OPERATION_LABEL = {
  merge: "Merge",
  cherry_pick: "Cherry-pick",
  rebase: "Rebase",
  revert: "Revert",
} as const;

const SUMMARY_SOFT_LIMIT = 72;
/** `Name <email@host>`: what a Co-authored-by trailer needs. */
const COAUTHOR = /^[^<>\r\n]+ <[^<>\s@]+@[^<>\s@]+>$/;

const paths = (e: StatusEntry): string[] => (e.orig_path ? [e.path, e.orig_path] : [e.path]);

interface Group {
  id: string;
  title: string;
  side: WorkSide;
  entries: StatusEntry[];
  code: (e: StatusEntry) => string;
  stats: (e: StatusEntry) => LineStats | null;
  /** Checked boxes mean "this is in the next commit". */
  checked: boolean;
  bulk?: { label: string; run: () => void };
  /** Throw away local changes to these entries (asks first). */
  discard?: (entries: StatusEntry[]) => void;
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
  onDiscard,
  onStash,
  loadLastMessage,
  loadTemplate,
}: Props) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [coAuthors, setCoAuthors] = useState<string[]>([]);
  const [coInput, setCoInput] = useState("");
  const [coOpen, setCoOpen] = useState(false);
  const templateTried = useRef(false);

  // A repository's commit template pre-fills an empty box once.
  useEffect(() => {
    if (templateTried.current || !status) return;
    templateTried.current = true;
    void loadTemplate().then((t) => {
      if (!t) return;
      const [first, ...rest] = t.replace(/\r/g, "").split("\n");
      setSummary((s) => s || first);
      setDescription((d) => d || rest.join("\n").trim());
    });
  }, [status, loadTemplate]);

  /** Amending starts from the previous message instead of an empty box. */
  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (on && !summary.trim() && !description.trim()) {
      void loadLastMessage().then((m) => {
        if (!m) return;
        const [first, ...rest] = m.replace(/\r/g, "").split("\n");
        setSummary(first);
        setDescription(rest.join("\n").trim());
      });
    }
  };

  const addCoAuthor = () => {
    const v = coInput.trim();
    if (!COAUTHOR.test(v)) return;
    setCoAuthors((l) => (l.includes(v) ? l : [...l, v]));
    setCoInput("");
  };
  const [collapsed, setCollapsed] = usePref<Record<string, boolean>>("changes.collapsed", {});

  if (!status) return <EmptyState icon={GitCommitHorizontal} title="No repository" hint="Open a repository to see its changes." />;

  const conflicted = status.entries.filter((e) => e.conflicted);
  const staged = status.entries.filter((e) => !e.conflicted && e.index);
  const unstaged = status.entries.filter((e) => !e.conflicted && !e.untracked && e.worktree);
  const untracked = status.entries.filter((e) => e.untracked);

  const groups: Group[] = [
    {
      id: "conflicts",
      title: "Conflicts",
      side: "unstaged",
      entries: conflicted,
      code: () => "U",
      stats: () => null,
      checked: false,
    },
    {
      id: "staged",
      title: "Staged",
      side: "staged",
      entries: staged,
      code: (e) => e.index ?? "?",
      stats: (e) => e.index_stats,
      checked: true,
      bulk: { label: "Unstage all", run: () => onUnstage(staged.flatMap(paths)) },
    },
    {
      id: "unstaged",
      title: "Changes",
      side: "unstaged",
      entries: unstaged,
      code: (e) => e.worktree ?? "?",
      stats: (e) => e.worktree_stats,
      checked: false,
      bulk: { label: "Stage all", run: () => onStage(unstaged.map((e) => e.path)) },
      discard: (es) => onDiscard(es.map((e) => e.path), false),
    },
    {
      id: "untracked",
      title: "Untracked",
      side: "untracked",
      entries: untracked,
      code: () => "?",
      stats: () => null,
      checked: false,
      bulk: { label: "Stage all", run: () => onStage(untracked.map((e) => e.path)) },
      discard: (es) => onDiscard(es.map((e) => e.path), true),
    },
  ];

  const isActive = (side: WorkSide, e: StatusEntry) =>
    activeDiff?.kind === "work" && activeDiff.side === side && activeDiff.path === e.path;

  const hasSummary = summary.trim().length > 0;
  const canCommit = !busy && hasSummary && (staged.length > 0 || amend) && conflicted.length === 0;
  // Trailers go in their own paragraph at the end, as git expects.
  const trailers = coAuthors.map((c) => `Co-authored-by: ${c}`).join("\n");
  const body = [description.trim(), trailers].filter(Boolean).join("\n\n");
  const message = body ? `${summary.trim()}\n\n${body}` : summary.trim();

  const submit = async () => {
    if (!canCommit) return;
    if (await onCommit(message, amend)) {
      setSummary("");
      setDescription("");
      setAmend(false);
      setCoAuthors([]);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const commitLabel = amend
    ? "Amend last commit"
    : staged.length > 0
      ? `Commit ${staged.length} file${staged.length === 1 ? "" : "s"}${status.branch ? ` to ${status.branch}` : ""}`
      : "Commit";

  return (
    <div className="changes">
      <div className="changes-scroll">
        {status.operation && (
          <div className="op-banner" role="status">
            <GitMerge size={16} />
            <div>
              <strong>{OPERATION_LABEL[status.operation]} in progress</strong>
              <p>
                {conflicted.length > 0
                  ? `Resolve ${conflicted.length} conflicted file${conflicted.length === 1 ? "" : "s"}, stage them, then continue.`
                  : "All conflicts are resolved. Ready to continue."}
              </p>
              <div className="op-actions">
                <Button size="sm" variant="primary" disabled={busy || conflicted.length > 0} onClick={onContinue}>
                  Continue
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={onAbort}>
                  Abort
                </Button>
              </div>
            </div>
          </div>
        )}

        {status.entries.length > 0 && !status.operation && (
          <div className="changes-tools">
            <Button size="sm" variant="ghost" icon={Archive} disabled={busy} onClick={onStash}>
              Stash changes…
            </Button>
          </div>
        )}

        {status.entries.length === 0 && !status.operation && (
          <EmptyState icon={CheckCircle2} title="Working tree clean" hint="Nothing to commit. Edit a file and it will show up here." />
        )}

        {groups.map((g) => {
          if (g.entries.length === 0) return null;
          const open = !collapsed[g.id];
          return (
            <section key={g.id} className="change-group">
              <div className="group-head">
                <button className="group-toggle" aria-expanded={open} onClick={() => setCollapsed((c) => ({ ...c, [g.id]: open }))}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{g.title}</span>
                  <Badge tone={g.id === "conflicts" ? "danger" : "neutral"}>{g.entries.length}</Badge>
                </button>
                {g.bulk && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={g.bulk.run}>
                    {g.bulk.label}
                  </Button>
                )}
                {g.discard && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => g.discard?.(g.entries)}>
                    Discard all
                  </Button>
                )}
                {g.id === "conflicts" && <ShieldAlert size={14} className="conflict-icon" />}
              </div>
              {open && (
                <ul className="file-list">
                  {g.entries.map((e) => (
                    <FileRow
                      key={`${g.id}:${e.path}`}
                      path={e.path}
                      origPath={e.orig_path}
                      code={g.code(e)}
                      stats={g.stats(e)}
                      active={isActive(g.side, e)}
                      onOpen={() =>
                        onOpenDiff({
                          kind: "work",
                          side: g.side,
                          path: e.path,
                          orig: g.side === "staged" ? e.orig_path : null,
                        })
                      }
                      leading={
                        g.id === "conflicts" ? undefined : (
                          <input
                            type="checkbox"
                            className="stage-check"
                            checked={g.checked}
                            disabled={busy}
                            aria-label={`${g.checked ? "Unstage" : "Stage"} ${e.path}`}
                            onChange={() => (g.checked ? onUnstage(paths(e)) : onStage([e.path]))}
                          />
                        )
                      }
                      trailing={
                        g.id === "conflicts" ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStage([e.path])} title="Mark resolved (stage)">
                            Resolved
                          </Button>
                        ) : g.discard ? (
                          <IconButton
                            icon={Undo2}
                            label={`Discard changes to ${e.path}`}
                            size="sm"
                            className="row-action"
                            disabled={busy}
                            onClick={() => g.discard?.([e])}
                          />
                        ) : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="identity" title="Change the active profile from the toolbar">
          {identity ? <Avatar name={identity.name} size={20} /> : <Avatar name="Git" size={20} />}
          <span>
            Committing as <strong>{identity ? identity.name : "your Git default identity"}</strong>
            {identity && <span className="muted"> &lt;{identity.email}&gt;</span>}
          </span>
        </div>
        <div className="summary-wrap">
          <input
            className="input"
            placeholder="Summary"
            aria-label="Commit summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={onKey}
          />
          <span className={summary.length > SUMMARY_SOFT_LIMIT ? "counter over" : "counter"}>
            {summary.length}/{SUMMARY_SOFT_LIMIT}
          </span>
        </div>
        <textarea
          className="textarea"
          placeholder="Description (optional)"
          aria-label="Commit description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="check-row">
          <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend the last commit
        </label>
        <div className="coauthors">
          <button type="button" className="link-btn" onClick={() => setCoOpen((o) => !o)}>
            {coOpen ? "Hide co-authors" : coAuthors.length ? `Co-authors (${coAuthors.length})` : "Add co-authors…"}
          </button>
          {coOpen && (
            <>
              <ul>
                {coAuthors.map((c) => (
                  <li key={c}>
                    <span className="selectable">{c}</span>
                    <button type="button" className="link-btn" onClick={() => setCoAuthors((l) => l.filter((x) => x !== c))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="coauthor-add">
                <input
                  className="input"
                  aria-label="Co-author"
                  placeholder="Name <email@example.com>"
                  value={coInput}
                  onChange={(e) => setCoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCoAuthor();
                    }
                  }}
                />
                <Button type="button" size="sm" disabled={!COAUTHOR.test(coInput.trim())} onClick={addCoAuthor}>
                  Add
                </Button>
              </div>
            </>
          )}
        </div>
        <Button type="submit" variant="primary" disabled={!canCommit} className="commit-btn">
          {commitLabel}
          <Shortcut keys="Ctrl+Enter" />
        </Button>
        {conflicted.length > 0 && <p className="muted small">Resolve the conflicts before committing.</p>}
      </form>
    </div>
  );
}
