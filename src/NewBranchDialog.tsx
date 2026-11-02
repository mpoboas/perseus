import { useState } from "react";
import { GitBranchPlus } from "lucide-react";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** Branch the new one starts from, shown so the user knows what they are branching off. */
  from: string;
  onCreate: (name: string) => void;
  onClose: () => void;
}

export function NewBranchDialog({ from, onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const ready = name.trim().length > 0;
  return (
    <Dialog
      title="New branch"
      width={440}
      onClose={onClose}
      onSubmit={() => ready && onCreate(name.trim())}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitBranchPlus} disabled={!ready}>
            Create and check out
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <TextField
          label="Branch name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="feature/my-change"
          hint={
            <>
              Starts from <code>{from}</code>.
            </>
          }
          spellCheck={false}
        />
      </div>
    </Dialog>
  );
}
