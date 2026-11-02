import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Download, FileText, Folder, GitCommitVertical, History, List, ListTree } from "lucide-react";
import { FileRow } from "./FileRow";
import type { CommitDetail, DiffTarget, FileChange, Person } from "./ipc";
import { relativeTime, shortSha } from "./lib/format";
import { type FileNode, buildFileTree } from "./lib/fileTree";
import { usePref } from "./lib/prefs";
import { Avatar, EmptyState, IconButton, Segmented, Skeleton, useToast } from "./ui";

interface Props {
  detail: CommitDetail | null;
  files: FileChange[];
  loading: boolean;
  error: string | null;
  activeDiff: DiffTarget | null;
  onJump: (oid: string) => void;
  onOpenFile: (oid: string, file: FileChange) => void;
  onFileHistory: (path: string) => void;
  onExportPatch: (oid: string) => void;
}

const when = (p: Person) => new Date(p.time * 1000).toLocaleString();

export function DetailPanel({ detail, files, loading, error, activeDiff, onJump, onOpenFile, onFileHistory, onExportPatch }: Props) {
  const toast = useToast();
  const [view, setView] = usePref<"tree" | "flat">("files.view", "tree");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (error) return <EmptyState title="Could not load this commit" hint={error} />;
  if (!detail) {
    return loading ? (
      <div className="detail-skeleton">
        <Skeleton width="70%" height={16} />
        <Skeleton width="40%" height={12} />
        <Skeleton height={64} />
      </div>
    ) : (
      <EmptyState icon={GitCommitVertical} title="No commit selected" hint="Click a commit in the graph to see its details." />
    );
  }

  const [title, ...rest] = detail.message.split("\n");
  const body = rest.join("\n").trim();
  const sameAsAuthor =
    detail.committer.name === detail.author.name &&
    detail.committer.email === detail.author.email &&
    detail.committer.time === detail.author.time;

  const totals = files.reduce(
    (t, f) => ({ add: t.add + (f.stats?.additions ?? 0), del: t.del + (f.stats?.deletions ?? 0) }),
    { add: 0, del: 0 },
  );

  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Could not access the clipboard"),
    );

  const isActive = (f: FileChange) =>
    activeDiff?.kind === "commit" && activeDiff.oid === detail.oid && activeDiff.path === f.path;

  const renderNodes = (nodes: FileNode<FileChange>[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      if (n.type === "file") {
        return (
          <FileRow
            key={n.item.path}
            path={n.item.path}
            origPath={n.item.orig_path}
            code={n.item.status}
            stats={n.item.stats}
            active={isActive(n.item)}
            nameOnly
            depth={depth}
            onOpen={() => onOpenFile(detail.oid, n.item)}
            trailing={
              <IconButton
                icon={History}
                label={`History of ${n.item.path}`}
                size="sm"
                className="row-action"
                onClick={() => onFileHistory(n.item.path)}
              />
            }
          />
        );
      }
      const open = !closed.has(n.path);
      return (
        <li key={n.path} className="tree-dir">
          <button
            className="dir-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            aria-expanded={open}
            onClick={() =>
              setClosed((c) => {
                const next = new Set(c);
                if (!next.delete(n.path)) next.add(n.path);
                return next;
              })
            }
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={13} />
            <span>{n.name}</span>
            <span className="side-count">{n.count}</span>
          </button>
          {open && <ul>{renderNodes(n.children, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <div className="detail">
      <div className="detail-head">
        <h2 className="detail-title selectable">{title}</h2>
        {body && <pre className="detail-body">{body}</pre>}

        <div className="person">
          <Avatar name={detail.author.name} size={28} />
          <div className="person-text">
            <strong>{detail.author.name}</strong>
            <span className="muted" title={when(detail.author)}>
              {detail.author.email} · {relativeTime(detail.author.time)}
            </span>
          </div>
        </div>
        {!sameAsAuthor && (
          <p className="muted small">
            Committed by {detail.committer.name} · {relativeTime(detail.committer.time)}
          </p>
        )}

        <div className="chips-row">
          <span className="meta-label">Commit</span>
          <button className="sha-chip" onClick={() => void copy(detail.oid, "commit id")} title="Copy full commit id">
            <code>{shortSha(detail.oid)}</code>
            <Copy size={11} />
          </button>
          <button className="sha-chip" onClick={() => onExportPatch(detail.oid)} title="Save this commit as a patch file">
            <Download size={11} /> Patch
          </button>
          {detail.parents.length > 0 && (
            <>
              <span className="meta-label">{detail.parents.length > 1 ? "Parents" : "Parent"}</span>
              {detail.parents.map((p) => (
                <button key={p} className="sha-chip link" onClick={() => onJump(p)} title="Jump to parent">
                  <code>{shortSha(p)}</code>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="files-head">
        <h3>
          <FileText size={14} /> {files.length} file{files.length === 1 ? "" : "s"}
          {(totals.add > 0 || totals.del > 0) && (
            <span className="stats">
              <span className="plus">+{totals.add}</span>
              <span className="minus">−{totals.del}</span>
            </span>
          )}
        </h3>
        <Segmented
          label="File view"
          iconOnly
          value={view}
          onChange={setView}
          options={[
            { value: "tree", label: "Tree view", icon: ListTree },
            { value: "flat", label: "List view", icon: List },
          ]}
        />
      </div>

      <ul className="file-list">
        {view === "tree"
          ? renderNodes(tree, 0)
          : files.map((f) => (
              <FileRow
                key={f.path}
                path={f.path}
                origPath={f.orig_path}
                code={f.status}
                stats={f.stats}
                active={isActive(f)}
                onOpen={() => onOpenFile(detail.oid, f)}
                trailing={
                  <IconButton
                    icon={History}
                    label={`History of ${f.path}`}
                    size="sm"
                    className="row-action"
                    onClick={() => onFileHistory(f.path)}
                  />
                }
              />
            ))}
        {files.length === 0 && <li className="muted pad">No file changes (an empty commit).</li>}
      </ul>
    </div>
  );
}
