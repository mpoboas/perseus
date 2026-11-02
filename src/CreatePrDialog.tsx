import { useState } from "react";
import { GitPullRequestArrow } from "lucide-react";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** The branch with the changes. */
  head: string;
  /** Candidates for the branch to merge into. */
  bases: string[];
  defaultBase: string;
  defaultTitle: string;
  /** The remote has no copy of the branch yet: the pull request would be empty. */
  notPushed: boolean;
  onCreate: (title: string, body: string, base: string, draft: boolean) => void;
  onClose: () => void;
}

export function CreatePrDialog({ head, bases, defaultBase, defaultTitle, notPushed, onCreate, onClose }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const ready = title.trim().length > 0 && base !== head;

  return (
    <Dialog
      title="Create a pull request"
      width={560}
      onClose={onClose}
      onSubmit={() => ready && onCreate(title.trim(), body.trim(), base, draft)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitPullRequestArrow} disabled={!ready}>
            Create pull request
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        {notPushed && (
          <div className="callout callout-warn">
            <p>
              <code>{head}</code> has not been pushed yet, so the provider cannot see it. Push (publish) the branch first.
            </p>
          </div>
        )}
        <div className="field">
          <label htmlFor="pr-base">Merge into</label>
          <div className="field-row">
            <select id="pr-base" className="select" value={base} onChange={(e) => setBase(e.target.value)}>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <span className="muted pr-from">
              from <code>{head}</code>
            </span>
          </div>
        </div>
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="field">
          <label htmlFor="pr-body">Description (optional)</label>
          <textarea id="pr-body" className="textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as a draft
        </label>
      </div>
    </Dialog>
  );
}
