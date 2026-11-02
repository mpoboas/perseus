import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, TriangleAlert, Wrench } from "lucide-react";
import { cancelGitOp, type MaintenanceTask, newOpId, repoStats, type RepoStats, runGitOp } from "./ipc";
import { kibytes } from "./lib/repos";
import { Button, Dialog } from "./ui";

interface Props {
  repoId: number;
  repoName: string;
  /** Called after a task changed the repository (refs or history may look different). */
  onChanged: () => void;
  onClose: () => void;
}

interface TaskInfo {
  id: MaintenanceTask;
  title: string;
  description: string;
  button: string;
}

const TASKS: TaskInfo[] = [
  {
    id: "gc",
    title: "Optimize the repository",
    description:
      "Packs loose objects, drops unreachable ones older than two weeks and tidies the references. Safe to run any time.",
    button: "Optimize",
  },
  {
    id: "commit_graph",
    title: "Rebuild the commit graph file",
    description: "A cache that makes history walks and path searches faster, mainly in large repositories.",
    button: "Rebuild",
  },
  {
    id: "fsck",
    title: "Check integrity",
    description: "Verifies that every object is intact and nothing reachable is missing. Can take a while on large repositories.",
    button: "Check",
  },
  {
    id: "prune_remotes",
    title: "Forget stale remote branches",
    description: "Removes remote-tracking branches whose branch no longer exists on the remote.",
    button: "Clean up",
  },
  {
    id: "gc_aggressive",
    title: "Deep optimize",
    description: "The same, with a much slower and deeper repack. Worth it once in a long while, if at all.",
    button: "Deep optimize",
  },
];

type Outcome = { task: MaintenanceTask; ok: boolean; text: string };

/** Size and upkeep of the repository's object store, with the git housekeeping tasks. */
export function MaintenanceDialog({ repoId, repoName, onChanged, onClose }: Props) {
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [running, setRunning] = useState<MaintenanceTask | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const opId = useRef<number | null>(null);
  const mounted = useRef(true);

  const loadStats = useCallback(() => {
    repoStats(repoId).then(
      (s) => mounted.current && (setStats(s), setStatsError(null)),
      (e) => mounted.current && setStatsError(String(e)),
    );
  }, [repoId]);

  useEffect(() => {
    mounted.current = true;
    loadStats();
    return () => {
      mounted.current = false;
      // Closing mid-task stops git rather than leaving it running unseen.
      if (opId.current !== null) void cancelGitOp(opId.current);
    };
  }, [loadStats]);

  const run = async (task: MaintenanceTask) => {
    const id = newOpId();
    opId.current = id;
    setRunning(task);
    setLines([]);
    setOutcome(null);
    const seen: string[] = [];
    try {
      const out = await runGitOp(
        repoId,
        { op: "maintenance", task },
        (line) => {
          seen.push(line);
          if (mounted.current) setLines((l) => [...l.slice(-200), line]);
        },
        id,
      );
      const text = out.trim() || seen.join("\n").trim();
      if (mounted.current) {
        setOutcome({
          task,
          ok: true,
          text: text || (task === "fsck" ? "No problems found." : "Done."),
        });
      }
      onChanged();
    } catch (e) {
      if (mounted.current) {
        // Git's own words: for the integrity check they are the list of what is wrong.
        const reported = seen.join("\n").trim();
        const message = String(e).replace(/^Error:\s*/, "");
        setOutcome({ task, ok: false, text: reported && !message.includes(reported) ? `${reported}\n${message}` : message });
      }
    } finally {
      opId.current = null;
      if (mounted.current) {
        setRunning(null);
        loadStats();
      }
    }
  };

  const shown = outcome?.text ?? lines.join("\n");
  return (
    <Dialog
      title={`Maintenance: ${repoName}`}
      width={620}
      onClose={onClose}
      footer={
        <>
          {running && (
            <Button variant="ghost" onClick={() => opId.current !== null && void cancelGitOp(opId.current)}>
              Stop
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        {statsError && <p className="muted">Could not read the repository's size: {statsError}</p>}
        {stats && (
          <>
            <div className="stat-grid" aria-label="Repository size">
              <div className="stat">
                <strong>{stats.loose_objects.toLocaleString()}</strong>
                <span>loose objects ({kibytes(stats.loose_kib)})</span>
              </div>
              <div className="stat">
                <strong>{stats.packed_objects.toLocaleString()}</strong>
                <span>
                  packed in {stats.packs} {stats.packs === 1 ? "pack" : "packs"} ({kibytes(stats.pack_kib)})
                </span>
              </div>
              <div className="stat">
                <strong>{stats.commit_graph ? "Yes" : "No"}</strong>
                <span>commit graph file</span>
              </div>
            </div>
            {(stats.gc_advised || stats.prune_packable > 0 || stats.garbage_files > 0) && (
              <div className="callout callout-warn" role="note">
                <TriangleAlert size={16} />
                <p>
                  Git would clean this repository up on its own soon
                  {stats.garbage_files > 0 && ` (${stats.garbage_files} stray files, ${kibytes(stats.garbage_kib)})`}. Optimizing it now keeps it fast.
                </p>
              </div>
            )}
          </>
        )}

        <ul className="maint-list">
          {TASKS.map((t) => (
            <li key={t.id} className="maint-task">
              <div>
                <strong>{t.title}</strong>
                <p>{t.description}</p>
              </div>
              <Button
                icon={Wrench}
                loading={running === t.id}
                disabled={running !== null}
                onClick={() => void run(t.id)}
                aria-label={t.title}
              >
                {t.button}
              </Button>
            </li>
          ))}
        </ul>

        {outcome && (
          <div className={outcome.ok ? "callout" : "callout callout-warn"} role="status">
            {outcome.ok ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
            <p>
              {outcome.ok
                ? `${TASKS.find((t) => t.id === outcome.task)?.title}: finished.`
                : outcome.task === "fsck"
                  ? "Git reported problems:"
                  : `${TASKS.find((t) => t.id === outcome.task)?.title}: it did not work.`}
            </p>
          </div>
        )}
        {shown && (
          <pre className={outcome && !outcome.ok ? "maint-log bad" : "maint-log"} aria-label="Output">
            {shown}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
