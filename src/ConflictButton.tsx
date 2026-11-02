import { useEffect, useMemo, useState } from "react";
import { predictMerge, type RefInfo } from "./ipc";
import { conflictTarget } from "./lib/conflicts";
import { Tooltip } from "./ui";

type Outcome =
  | { kind: "none"; reason: string }
  | { kind: "checking"; ref: string }
  | { kind: "clean"; ref: string }
  | { kind: "conflicts"; ref: string; files: string[] }
  | { kind: "unsupported" }
  | { kind: "failed"; ref: string };

const SHOWN_FILES = 6;

/** A `>` pointing at a target, like GitKraken's conflict detection icon. */
function ConflictIcon({ size = 21 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5 7 12l-4.5 4.5" />
      <path d="M9 12h3" />
      <circle cx="17" cy="12" r="4.8" />
      <circle cx="17" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

const Ref = ({ name }: { name: string }) => <span className="tip-ref">{name}</span>;

/**
 * Would the current branch merge cleanly into the main branch? Asked of git without touching the working
 * tree (`merge-tree`), again whenever either branch moves, or when the button is pressed.
 */
export function ConflictButton({
  repoId,
  branch,
  refs,
  onMerge,
  disabled,
}: {
  repoId: number;
  branch: string | null;
  refs: RefInfo[];
  /** Pressing the button merges the current branch into the main branch (`ref` is what was compared against). */
  onMerge: (branch: string, ref: string) => void;
  disabled?: boolean;
}) {
  const plan = useMemo(() => conflictTarget(refs, branch), [refs, branch]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none", reason: "" });
  const [again, setAgain] = useState(0);
  const key = plan.kind === "target" ? `${plan.ref}:${plan.headOid}:${plan.targetOid}` : plan.reason;

  useEffect(() => {
    if (plan.kind === "none") {
      setOutcome({ kind: "none", reason: plan.reason });
      return;
    }
    let live = true;
    setOutcome({ kind: "checking", ref: plan.ref });
    predictMerge(repoId, "HEAD", plan.ref).then(
      (p) => {
        if (!live) return;
        if (!p.supported) setOutcome({ kind: "unsupported" });
        else if (p.conflicts.length > 0) setOutcome({ kind: "conflicts", ref: plan.ref, files: p.conflicts });
        else setOutcome({ kind: "clean", ref: plan.ref });
      },
      () => live && setOutcome({ kind: "failed", ref: plan.ref }),
    );
    return () => {
      live = false;
    };
    // `key` stands for the plan's contents, so a refresh that changes nothing does not run git again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key, again]);

  const tip = (() => {
    switch (outcome.kind) {
      case "none":
        return outcome.reason;
      case "checking":
        return <>Checking for conflicts against <Ref name={outcome.ref} /></>;
      case "clean":
        return <>No conflicts detected against <Ref name={outcome.ref} /></>;
      case "conflicts":
        return (
          <div className="tip-conflicts">
            <div>
              {outcome.files.length === 1 ? "1 file would conflict" : `${outcome.files.length} files would conflict`} against <Ref name={outcome.ref} />
            </div>
            <ul>
              {outcome.files.slice(0, SHOWN_FILES).map((f) => (
                <li key={f}>{f}</li>
              ))}
              {outcome.files.length > SHOWN_FILES && <li className="more">…and {outcome.files.length - SHOWN_FILES} more</li>}
            </ul>
          </div>
        );
      case "unsupported":
        return "Conflict detection needs git 2.38 or newer";
      case "failed":
        return <>Could not check for conflicts against <Ref name={outcome.ref} /></>;
    }
  })();

  const state = outcome.kind === "conflicts" ? "has-conflicts" : outcome.kind === "clean" ? "is-clean" : "";
  const canMerge = plan.kind === "target" && !!branch;
  const press = () => {
    if (canMerge && branch) onMerge(branch, plan.ref);
    else setAgain((n) => n + 1);
  };
  const hint = canMerge ? (
    <div className="tip-hint">
      Click to merge <Ref name={branch} /> into the main branch
    </div>
  ) : null;
  return (
    <Tooltip
      label={
        <>
          {tip}
          {hint}
        </>
      }
    >
      <button
        className={`icon-btn conflict-btn ${state}`}
        aria-label="Conflict detection and merge"
        disabled={disabled || outcome.kind === "none" || outcome.kind === "unsupported"}
        onClick={press}
      >
        <ConflictIcon />
        {outcome.kind === "conflicts" && <span className="conflict-count">{outcome.files.length}</span>}
      </button>
    </Tooltip>
  );
}
