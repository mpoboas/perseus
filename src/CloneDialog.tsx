import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** Starts the clone; the folder to put it in is chosen in a native dialog afterwards. */
  onClone: (url: string) => void;
  onClose: () => void;
}

export function CloneDialog({ onClone, onClose }: Props) {
  const [url, setUrl] = useState("");
  const ready = url.trim().length > 0;
  return (
    <Dialog
      title="Clone a repository"
      width={520}
      onClose={onClose}
      onSubmit={() => ready && onClone(url.trim())}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={Download} disabled={!ready}>
            Choose folder and clone
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <TextField
          label="Repository URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          hint="Private repositories use the access tokens of the active profile (set in the toolbar)."
        />
      </div>
    </Dialog>
  );
}
