import { useState } from "react";
import { Archive } from "lucide-react";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** How many changed files the stash will take, for the summary line. */
  changed: number;
  untracked: number;
  onStash: (message: string, includeUntracked: boolean) => void;
  onClose: () => void;
}

export function StashDialog({ changed, untracked, onStash, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(untracked > 0);

  return (
    <Dialog
      title="Stash changes"
      width={460}
      onClose={onClose}
      onSubmit={() => onStash(message.trim(), includeUntracked)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={Archive}>
            Stash
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Saves {changed} changed file{changed === 1 ? "" : "s"} on the side and restores a clean working
          tree. You can apply them again from the sidebar.
        </p>
        <TextField
          label="Message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="WIP: what you were doing"
        />
        {untracked > 0 && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />{" "}
            Also stash {untracked} untracked file{untracked === 1 ? "" : "s"}
          </label>
        )}
      </div>
    </Dialog>
  );
}
