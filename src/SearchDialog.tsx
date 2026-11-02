import { useState } from "react";
import { Search } from "lucide-react";
import { type SearchHit, searchCommits } from "./ipc";
import { relativeTime, shortSha } from "./lib/format";
import { Avatar, Button, Dialog, EmptyState, Spinner, TextField } from "./ui";

interface Props {
  repoId: number;
  /** Shows the commit in the graph (closing the dialog). */
  onJump: (oid: string) => void;
  onClose: () => void;
}

export function SearchDialog({ repoId, onJump, onClose }: Props) {
  const [form, setForm] = useState({ text: "", author: "", since: "", until: "", path: "" });
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; hits: SearchHit[]; truncated: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const empty = Object.values(form).every((v) => !v.trim());

  const run = async () => {
    setState({ kind: "running" });
    try {
      const r = await searchCommits(repoId, form);
      setState({ kind: "done", hits: r.hits, truncated: r.truncated });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  };

  return (
    <Dialog
      title="Search commits"
      width={760}
      onClose={onClose}
      onSubmit={() => !empty && void run()}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" variant="primary" icon={Search} disabled={empty || state.kind === "running"}>
            Search
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <div className="search-grid">
          <TextField label="Message contains" value={form.text} onChange={set("text")} placeholder="fix parser" spellCheck={false} />
          <TextField label="Author" value={form.author} onChange={set("author")} placeholder="name or email" spellCheck={false} />
          <TextField label="From (inclusive)" type="date" value={form.since} onChange={set("since")} />
          <TextField label="To (inclusive)" type="date" value={form.until} onChange={set("until")} />
          <TextField
            label="Touched file"
            value={form.path}
            onChange={set("path")}
            placeholder="src/main.rs"
            spellCheck={false}
            hint="Searches every branch. Message and author are matched as plain text, ignoring case."
          />
        </div>

        {state.kind === "running" && (
          <p className="muted">
            <Spinner size={12} /> Searching…
          </p>
        )}
        {state.kind === "error" && <div className="callout callout-error">{state.message}</div>}
        {state.kind === "done" &&
          (state.hits.length === 0 ? (
            <EmptyState icon={Search} title="No commits match" hint="Try fewer filters or a shorter phrase." />
          ) : (
            <>
              <p className="muted small">
                {state.hits.length.toLocaleString()} result{state.hits.length === 1 ? "" : "s"}
                {state.truncated ? " (the first 2,000 — narrow the search to see others)" : ""}
              </p>
              <ul className="history-list" aria-label="Search results">
                {state.hits.map((h) => (
                  <li key={h.oid}>
                    <button type="button" className="history-row" onClick={() => onJump(h.oid)}>
                      <Avatar name={h.author} size={20} />
                      <span className="history-summary">{h.summary}</span>
                      <span className="muted small">{h.author}</span>
                      <code>{shortSha(h.oid)}</code>
                      <span className="muted small">{relativeTime(h.time)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </div>
    </Dialog>
  );
}
