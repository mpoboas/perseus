import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FileX } from "lucide-react";
import { type ConflictDetail, type ConflictKind, type Resolution, conflictDetail } from "./ipc";
import { splitPath } from "./lib/format";
import { Badge, Button, Dialog, EmptyState, Skeleton } from "./ui";

interface Props {
  repoId: number;
  path: string;
  /** Writes the resolution and stages the file. Resolves true on success. */
  onResolve: (path: string, how: Resolution) => Promise<boolean>;
  onClose: () => void;
}

type Choice = "ours" | "theirs" | "both" | "theirs_then_ours" | "base" | "custom";

const KIND_TEXT: Record<ConflictKind, string> = {
  both_modified: "Both sides changed this file.",
  both_added: "Both sides added this file with different contents.",
  deleted_by_us: "You deleted this file, but the other side changed it.",
  deleted_by_them: "The other side deleted this file, but you changed it.",
  added_by_us: "Only your side added this file.",
  added_by_them: "Only the other side added this file.",
  both_deleted: "Both sides deleted this file.",
};

/** The text a choice stands for. */
function pick(
  c: { ours: string; base: string | null; theirs: string },
  choice: Choice,
  custom: string,
): string {
  switch (choice) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "both":
      return c.ours + c.theirs;
    case "theirs_then_ours":
      return c.theirs + c.ours;
    case "base":
      return c.base ?? "";
    case "custom":
      return custom;
  }
}

export function ConflictDialog({ repoId, path, onResolve, onClose }: Props) {
  const [detail, setDetail] = useState<ConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const { dir, name } = splitPath(path);

  useEffect(() => {
    conflictDetail(repoId, path).then(setDetail, (e) => setError(String(e)));
  }, [repoId, path]);

  const conflictIdx = useMemo(
    () => (detail?.segments ?? []).flatMap((s, i) => (s.type === "conflict" ? [i] : [])),
    [detail],
  );
  const unresolved = conflictIdx.filter((i) => choices[i] === undefined).length;

  const output = useMemo(() => {
    if (!detail) return "";
    return detail.segments
      .map((s, i) => (s.type === "text" ? s.text : pick(s, choices[i] ?? "ours", custom[i] ?? "")))
      .join("");
  }, [detail, choices, custom]);

  const finish = async (how: Resolution) => {
    setBusy(true);
    const ok = await onResolve(path, how);
    setBusy(false);
    if (ok) onClose();
  };

  const all = (choice: Choice) =>
    setChoices(Object.fromEntries(conflictIdx.map((i) => [i, choice])) as Record<number, Choice>);

  const body = () => {
    if (error) return <EmptyState icon={AlertTriangle} title="Could not read this conflict" hint={error} />;
    if (!detail) return <Skeleton height={60} />;

    // Whole-file decisions: binary files, and delete-versus-modify conflicts.
    if (detail.binary || detail.segments.length === 0) {
      const oursGone = detail.ours === null;
      const theirsGone = detail.theirs === null;
      return (
        <div className="conflict-whole">
          <p className="lede">
            {KIND_TEXT[detail.kind]}
            {detail.binary && " It is a binary file, so it cannot be merged line by line."}
          </p>
          <div className="conflict-choices">
            <Button icon={oursGone ? FileX : Check} disabled={busy} onClick={() => void finish({ how: "ours" })}>
              {oursGone ? "Keep it deleted (your side)" : "Keep your version"}
            </Button>
            <Button icon={theirsGone ? FileX : Check} disabled={busy} onClick={() => void finish({ how: "theirs" })}>
              {theirsGone ? "Delete it (their side)" : "Take their version"}
            </Button>
            {!oursGone && !theirsGone ? null : (
              <Button variant="danger" icon={FileX} disabled={busy} onClick={() => void finish({ how: "delete" })}>
                Delete the file
              </Button>
            )}
          </div>
        </div>
      );
    }

    let n = 0;
    return (
      <div className="conflict-body">
        {detail.segments.map((s, i) => {
          if (s.type === "text") {
            const lines = s.text.split("\n");
            const long = lines.length > 7;
            return (
              <pre key={i} className="conflict-text">
                {long ? [...lines.slice(0, 3), `⋯ ${lines.length - 6} unchanged lines ⋯`, ...lines.slice(-3)].join("\n") : s.text}
              </pre>
            );
          }
          n += 1;
          const choice = choices[i];
          return (
            <section key={i} className={choice ? "conflict-region resolved" : "conflict-region"}>
              <header>
                <strong>
                  Conflict {n} of {conflictIdx.length}
                </strong>
                {choice ? <Badge tone="success">resolved</Badge> : <Badge tone="warn">needs a choice</Badge>}
              </header>
              <div className="conflict-panes">
                <div>
                  <h4>Yours</h4>
                  <pre>{s.ours || " "}</pre>
                </div>
                {s.base !== null && (
                  <div>
                    <h4>Original</h4>
                    <pre>{s.base || " "}</pre>
                  </div>
                )}
                <div>
                  <h4>Theirs</h4>
                  <pre>{s.theirs || " "}</pre>
                </div>
              </div>
              <div className="conflict-pick" role="radiogroup" aria-label={`Resolve conflict ${n}`}>
                {(
                  [
                    ["ours", "Yours"],
                    ["theirs", "Theirs"],
                    ["both", "Yours, then theirs"],
                    ["theirs_then_ours", "Theirs, then yours"],
                    ...(s.base !== null ? [["base", "Original"]] : []),
                    ["custom", "Edit…"],
                  ] as [Choice, string][]
                ).map(([value, label]) => (
                  <label key={value} className={choice === value ? "chip-radio active" : "chip-radio"}>
                    <input
                      type="radio"
                      name={`conflict-${i}`}
                      checked={choice === value}
                      onChange={() => {
                        setChoices((c) => ({ ...c, [i]: value }));
                        if (value === "custom" && custom[i] === undefined) {
                          setCustom((t) => ({ ...t, [i]: choice ? pick(s, choice, t[i] ?? "") : s.ours }));
                        }
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {choice === "custom" && (
                <textarea
                  className="textarea conflict-edit"
                  aria-label={`Edit conflict ${n}`}
                  rows={Math.min(12, Math.max(3, (custom[i] ?? "").split("\n").length + 1))}
                  value={custom[i] ?? ""}
                  onChange={(e) => setCustom((t) => ({ ...t, [i]: e.target.value }))}
                  spellCheck={false}
                />
              )}
            </section>
          );
        })}
        <details className="conflict-result">
          <summary>Preview the resulting file</summary>
          <pre>{output}</pre>
        </details>
      </div>
    );
  };

  const hasSegments = !!detail && !detail.binary && detail.segments.length > 0;
  return (
    <Dialog
      title={`Resolve ${name}`}
      width={980}
      onClose={onClose}
      footer={
        hasSegments ? (
          <>
            <span className="muted small grow">
              {unresolved === 0 ? "Every conflict has a choice." : `${unresolved} conflict${unresolved === 1 ? "" : "s"} still need a choice.`}
            </span>
            <Button variant="ghost" onClick={() => all("ours")}>
              Take all yours
            </Button>
            <Button variant="ghost" onClick={() => all("theirs")}>
              Take all theirs
            </Button>
            <Button
              variant="primary"
              icon={Check}
              disabled={busy || unresolved > 0}
              onClick={() => void finish({ how: "content", text: output })}
            >
              Save and mark resolved
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="dialog-body conflict-dialog">
        <div className="history-head">
          <span className="file-dir">{dir}</span>
          <strong>{name}</strong>
          {detail && <span className="muted small">{KIND_TEXT[detail.kind]}</span>}
        </div>
        {body()}
      </div>
    </Dialog>
  );
}
