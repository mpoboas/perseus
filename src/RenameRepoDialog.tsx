import { useState } from "react";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** The folder's own name, shown as the placeholder and restored by clearing the field. */
  folderName: string;
  alias: string | null;
  onSave: (alias: string | null) => void;
  onClose: () => void;
}

export const MAX_ALIAS = 60;

/** Gives a repository a name of the user's own. Only Perseus's display changes, never the folder. */
export function RenameRepoDialog({ folderName, alias, onSave, onClose }: Props) {
  const [text, setText] = useState(alias ?? "");
  const tooLong = text.trim().length > MAX_ALIAS;

  return (
    <Dialog
      title="Rename in Perseus"
      width={440}
      onClose={onClose}
      onSubmit={() => !tooLong && onSave(text.trim() || null)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={tooLong}>
            Save
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Choose how this repository is named in tabs and lists. The folder on disk keeps the name{" "}
          <code>{folderName}</code>. Leave the field empty to go back to it.
        </p>
        <TextField
          label="Name"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={folderName}
          maxLength={MAX_ALIAS + 20}
          hint={tooLong ? `At most ${MAX_ALIAS} characters` : undefined}
        />
      </div>
    </Dialog>
  );
}
