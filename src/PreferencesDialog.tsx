import { useEffect, useState } from "react";
import { type LogEntry, activityLog } from "./ipc";
import { usePref } from "./lib/prefs";
import { Button, Dialog } from "./ui";

/** Staged files above this many megabytes trigger a warning (0 turns it off). */
export const LARGE_FILE_KEY = "largeFileMegabytes";
export const LARGE_FILE_DEFAULT = 50;

const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour12: false });

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const [megabytes, setMegabytes] = usePref<number>(LARGE_FILE_KEY, LARGE_FILE_DEFAULT);
  const [reads, setReads] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const reload = () => void activityLog().then(setLog, () => setLog([]));
  useEffect(reload, []);

  const shown = log.filter((e) => reads || !e.read_only).slice(-200).reverse();

  return (
    <Dialog
      title="Preferences"
      width={680}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="dialog-body prefs">
        <section>
          <h3>Large files</h3>
          <label className="check-row">
            Warn before committing files bigger than
            <input
              className="input prefs-number"
              type="number"
              min={0}
              max={4096}
              aria-label="Large file threshold in megabytes"
              value={megabytes}
              onChange={(e) => setMegabytes(Math.max(0, Math.min(4096, Math.floor(Number(e.target.value) || 0))))}
            />
            MB
          </label>
          <p className="muted small">Files stay in the history forever once committed. GitHub refuses files over 100 MB.</p>
        </section>

        <section>
          <div className="prefs-head">
            <h3>Activity log</h3>
            <label className="check-row">
              <input type="checkbox" checked={reads} onChange={(e) => setReads(e.target.checked)} /> Show read-only commands
            </label>
            <Button size="sm" variant="ghost" onClick={reload}>
              Refresh
            </Button>
          </div>
          <p className="muted small">
            Every git command Perseus ran for you, newest first. Passwords inside URLs are hidden. Nothing leaves your computer.
          </p>
          <ol className="activity-log selectable" aria-label="Git commands">
            {shown.length === 0 && <li className="muted">Nothing yet</li>}
            {shown.map((e, i) => (
              <li key={`${e.time}-${i}`} className={e.ok ? "" : "failed"}>
                <time>{clock(e.time)}</time>
                <code>{e.command}</code>
                <span className="muted">{e.millis} ms</span>
                {e.error && <em>{e.error}</em>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Dialog>
  );
}
