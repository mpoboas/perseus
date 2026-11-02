import { useState } from "react";
import { Package } from "lucide-react";
import { folderFromUrl } from "./lib/format";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  onAdd: (url: string, path: string) => void;
  onClose: () => void;
}

/** Adds another repository inside this one, at a folder of its own. */
export function AddSubmoduleDialog({ onAdd, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState<string | null>(null);
  // Until the folder is typed in by hand it follows the address.
  const folder = path ?? folderFromUrl(url);
  const ready = url.trim() !== "" && folder.trim() !== "";

  return (
    <Dialog
      title="Add a submodule"
      width={500}
      onClose={onClose}
      onSubmit={() => ready && onAdd(url.trim(), folder.trim())}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={Package} disabled={!ready}>
            Add submodule
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Downloads another repository into a folder of this one and records which commit of it to use.
          The change is staged: commit it to make the submodule part of the project.
        </p>
        <TextField
          label="Repository address"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/library.git, or a folder on this computer"
        />
        <TextField
          label="Folder inside this repository"
          value={folder}
          onChange={(e) => setPath(e.target.value)}
          placeholder="libs/library"
        />
      </div>
    </Dialog>
  );
}
