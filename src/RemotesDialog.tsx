import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { GitAction, RemoteInfo } from "./ipc";
import { Badge, Button, Dialog, IconButton } from "./ui";

interface Props {
  remotes: RemoteInfo[];
  /** Runs one action and resolves true when it succeeded (the list refreshes behind it). */
  onAction: (action: GitAction, done: string) => Promise<boolean>;
  onClose: () => void;
}

type Edit = { name: string; newName: string; url: string } | null;

export function RemotesDialog({ remotes, onAction, onClose }: Props) {
  const [edit, setEdit] = useState<Edit>(null);
  const [adding, setAdding] = useState({ name: "", url: "" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const saveEdit = async () => {
    if (!edit) return;
    const original = remotes.find((r) => r.name === edit.name);
    if (!original) return;
    let ok = true;
    if (edit.url !== original.fetch_url) {
      ok = await onAction({ action: "remote_set_url", name: edit.name, url: edit.url }, `Updated ${edit.name}`);
    }
    if (ok && edit.newName !== edit.name) {
      ok = await onAction({ action: "remote_rename", old: edit.name, new: edit.newName }, `Renamed to ${edit.newName}`);
    }
    if (ok) setEdit(null);
  };

  const add = async () => {
    const ok = await onAction({ action: "remote_add", name: adding.name.trim(), url: adding.url.trim() }, `Added ${adding.name.trim()}`);
    if (ok) setAdding({ name: "", url: "" });
  };

  return (
    <Dialog
      title="Remotes"
      width={620}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="dialog-body">
        {remotes.length === 0 && <p className="muted">This repository has no remotes yet.</p>}
        <ul className="remote-list">
          {remotes.map((r) => (
            <li key={r.name} className="remote-row">
              {edit?.name === r.name ? (
                <form
                  className="remote-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit();
                  }}
                >
                  <input
                    className="input"
                    aria-label="Remote name"
                    value={edit.newName}
                    onChange={(e) => setEdit({ ...edit, newName: e.target.value })}
                  />
                  <input
                    className="input"
                    aria-label="Remote URL"
                    value={edit.url}
                    onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  />
                  <IconButton icon={Check} label="Save" type="submit" size="sm" />
                  <IconButton icon={X} label="Cancel" type="button" size="sm" onClick={() => setEdit(null)} />
                </form>
              ) : (
                <>
                  <div className="remote-text">
                    <strong>{r.name}</strong>
                    <span className="selectable">{r.fetch_url}</span>
                    {r.push_url !== r.fetch_url && <Badge tone="warn">push: {r.push_url}</Badge>}
                  </div>
                  {confirmRemove === r.name ? (
                    <>
                      <span className="muted small">Remove {r.name}?</span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void onAction({ action: "remote_remove", name: r.name }, `Removed ${r.name}`).then(() => setConfirmRemove(null))}
                      >
                        Remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <>
                      <IconButton
                        icon={Pencil}
                        label={`Edit ${r.name}`}
                        size="sm"
                        onClick={() => setEdit({ name: r.name, newName: r.name, url: r.fetch_url })}
                      />
                      <IconButton icon={Trash2} label={`Remove ${r.name}`} size="sm" onClick={() => setConfirmRemove(r.name)} />
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        <form
          className="remote-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="input"
            aria-label="New remote name"
            placeholder="origin"
            value={adding.name}
            onChange={(e) => setAdding({ ...adding, name: e.target.value })}
          />
          <input
            className="input"
            aria-label="New remote URL"
            placeholder="https://github.com/you/repo.git"
            value={adding.url}
            onChange={(e) => setAdding({ ...adding, url: e.target.value })}
          />
          <Button type="submit" icon={Plus} disabled={!adding.name.trim() || !adding.url.trim()}>
            Add remote
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
