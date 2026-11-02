import { useState } from "react";
import { GitFork, TriangleAlert } from "lucide-react";
import type { HostingInfo } from "./ipc";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  hosting: HostingInfo;
  /** Names of the remotes this repository already has. */
  remotes: string[];
  onFork: (fork: { name: string | null; namespace: string | null }, remote: { name: string | null; make_origin: boolean }) => void;
  onClose: () => void;
}

/** Copies the repository to the signed-in account (or an organization) on its host, and adds the copy as a remote. */
export function ForkDialog({ hosting, remotes, onFork, onClose }: Props) {
  const gitlab = hosting.kind === "git_lab";
  const original = hosting.path.split("/").pop() ?? hosting.path;
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [makeOrigin, setMakeOrigin] = useState(false);

  const canOrigin = remotes.includes("origin") && !remotes.includes("upstream");
  const clash = !makeOrigin && remoteName.trim() !== "" && remotes.includes(remoteName.trim());
  const ready = hosting.signed_in && !clash;

  return (
    <Dialog
      title={`Fork ${hosting.path}`}
      width={520}
      onClose={onClose}
      onSubmit={() =>
        ready &&
        onFork(
          { name: name.trim() || null, namespace: namespace.trim() || null },
          { name: makeOrigin ? null : remoteName.trim() || null, make_origin: makeOrigin },
        )
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitFork} disabled={!ready}>
            Fork
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Makes your own copy of this project on {hosting.host}, so you can push changes the original does not let you
          push, and offer them back with a {gitlab ? "merge" : "pull"} request. Perseus then adds the copy as a remote.
        </p>
        {!hosting.signed_in && (
          <div className="callout callout-warn" role="note">
            <TriangleAlert size={16} />
            <p>Sign in to {hosting.host} from Profiles first: forking is done with your account.</p>
          </div>
        )}
        <TextField
          label="Name of the fork (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={original}
        />
        <TextField
          label={gitlab ? "Group (optional)" : "Organization (optional)"}
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          placeholder="your own account"
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={makeOrigin}
            disabled={!canOrigin}
            onChange={(e) => setMakeOrigin(e.target.checked)}
          />{" "}
          Make the fork <code>origin</code> and keep the original as <code>upstream</code>
        </label>
        {makeOrigin ? (
          <p className="muted small">
            Pushes go to the fork; pulls still follow the original project.
          </p>
        ) : (
          <TextField
            label="Remote name (optional)"
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            placeholder="the fork owner's name"
            hint={clash ? `A remote called ${remoteName.trim()} already exists` : undefined}
          />
        )}
        {!canOrigin && (
          <p className="muted small">
            {remotes.includes("upstream")
              ? "Making the fork origin is off because a remote called upstream already exists."
              : "Making the fork origin needs a remote called origin."}
          </p>
        )}
      </div>
    </Dialog>
  );
}
