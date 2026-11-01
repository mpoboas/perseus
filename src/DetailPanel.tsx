import type { CommitDetail, DiffTarget, FileChange, Person } from "./ipc";

interface Props {
  detail: CommitDetail | null;
  files: FileChange[];
  error: string | null;
  activeDiff: DiffTarget | null;
  onJump: (oid: string) => void;
  onOpenFile: (oid: string, file: FileChange) => void;
}

function when(p: Person) {
  return new Date(p.time * 1000).toLocaleString();
}

export function DetailPanel({ detail, files, error, activeDiff, onJump, onOpenFile }: Props) {
  if (error) return <aside className="detail error">{error}</aside>;
  if (!detail) return <aside className="detail empty">Select a commit</aside>;

  const [title, ...rest] = detail.message.split("\n");
  const body = rest.join("\n").trim();
  const sameAsAuthor =
    detail.committer.name === detail.author.name &&
    detail.committer.email === detail.author.email &&
    detail.committer.time === detail.author.time;

  return (
    <aside className="detail">
      <h2 className="detail-title">{title}</h2>
      {body && <pre className="detail-body">{body}</pre>}
      <dl>
        <dt>Commit</dt>
        <dd>
          <code>{detail.oid}</code>
        </dd>
        <dt>Author</dt>
        <dd>
          {detail.author.name} &lt;{detail.author.email}&gt;
          <br />
          <span className="muted">{when(detail.author)}</span>
        </dd>
        {!sameAsAuthor && (
          <>
            <dt>Committer</dt>
            <dd>
              {detail.committer.name} &lt;{detail.committer.email}&gt;
              <br />
              <span className="muted">{when(detail.committer)}</span>
            </dd>
          </>
        )}
        {detail.parents.length > 0 && (
          <>
            <dt>{detail.parents.length > 1 ? "Parents" : "Parent"}</dt>
            <dd>
              {detail.parents.map((p) => (
                <button key={p} className="link" onClick={() => onJump(p)}>
                  {p.slice(0, 7)}
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>

      <h3 className="files-title">
        Files changed <span className="count">{files.length}</span>
      </h3>
      <ul className="files">
        {files.map((f) => {
          const active =
            activeDiff?.kind === "commit" &&
            activeDiff.oid === detail.oid &&
            activeDiff.path === f.path;
          return (
            <li key={f.path} className={active ? "change active" : "change"}>
              <span className={`st st-${f.status}`}>{f.status}</span>
              <button
                className="path"
                title={f.path}
                onClick={() => onOpenFile(detail.oid, f)}
              >
                {f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
