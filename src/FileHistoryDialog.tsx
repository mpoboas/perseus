import { useEffect, useMemo, useRef, useState } from "react";
import { GitCommitVertical, History, Users } from "lucide-react";
import { type Blame, type FileCommit, fileBlame, fileHistory } from "./ipc";
import { relativeTime, shortSha, splitPath } from "./lib/format";
import { Avatar, Button, Dialog, EmptyState, Segmented, Skeleton } from "./ui";

interface Props {
  repoId: number;
  path: string;
  /** Opens the commit in the main graph and closes this dialog. */
  onJump: (oid: string) => void;
  onClose: () => void;
}

const ROW_H = 22;

export function FileHistoryDialog({ repoId, path, onJump, onClose }: Props) {
  const [view, setView] = useState<"history" | "blame">("history");
  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dir, name } = splitPath(path);

  useEffect(() => {
    fileHistory(repoId, path).then(setCommits, (e) => setError(String(e)));
  }, [repoId, path]);

  useEffect(() => {
    if (view === "blame" && !blame) fileBlame(repoId, path, null).then(setBlame, (e) => setError(String(e)));
  }, [view, blame, repoId, path]);

  return (
    <Dialog
      title={`History of ${name}`}
      width={900}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="dialog-body history-body">
        <div className="history-head">
          <span className="file-dir">{dir}</span>
          <strong>{name}</strong>
          <span className="grow" />
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "history", label: "Commits", icon: History },
              { value: "blame", label: "Blame", icon: Users },
            ]}
          />
        </div>
        {error ? (
          <EmptyState title="Could not read the file's history" hint={error} />
        ) : view === "history" ? (
          commits === null ? (
            <Skeleton height={14} />
          ) : commits.length === 0 ? (
            <EmptyState icon={GitCommitVertical} title="No commits touched this file" hint="It may be new and not committed yet." />
          ) : (
            <ul className="history-list">
              {commits.map((c) => (
                <li key={c.oid}>
                  <button className="history-row" onClick={() => onJump(c.oid)} title="Show this commit in the graph">
                    <Avatar name={c.author} size={20} />
                    <span className="history-summary">{c.summary}</span>
                    <code>{shortSha(c.oid)}</code>
                    <span className="muted small">{relativeTime(c.time)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : blame === null ? (
          <Skeleton height={14} />
        ) : (
          <BlameTable blame={blame} onJump={onJump} />
        )}
      </div>
    </Dialog>
  );
}

function BlameTable({ blame, onJump }: { blame: Blame; onJump: (oid: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(420);

  useEffect(() => {
    const el = box.current;
    if (el) setHeight(el.clientHeight);
  }, []);

  // Neighbouring lines from one commit share a band, so the commit reads once per block.
  const firstOfBlock = useMemo(
    () => blame.lines.map((l, i) => i === 0 || blame.lines[i - 1].oid !== l.oid),
    [blame],
  );
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(blame.lines.length, Math.ceil((scrollTop + height) / ROW_H) + 10);

  return (
    <div ref={box} className="blame" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: blame.lines.length * ROW_H, position: "relative" }}>
        {blame.lines.slice(first, last).map((l, i) => {
          const at = first + i;
          return (
            <div key={l.line} className={firstOfBlock[at] ? "blame-line block-start" : "blame-line"} style={{ top: at * ROW_H, height: ROW_H }}>
              <button
                className="blame-who"
                onClick={() => onJump(l.oid)}
                title={`${l.summary}\n${new Date(l.time * 1000).toLocaleString()}`}
              >
                {firstOfBlock[at] ? (
                  <>
                    <code>{shortSha(l.oid)}</code>
                    <span>{l.author}</span>
                    <span className="muted">{relativeTime(l.time)}</span>
                  </>
                ) : null}
              </button>
              <span className="blame-no">{l.line}</span>
              <span className="blame-text">{l.text || " "}</span>
            </div>
          );
        })}
      </div>
      {blame.truncated && <p className="muted small pad">Showing the first {blame.lines.length.toLocaleString()} lines.</p>}
    </div>
  );
}
