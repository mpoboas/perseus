import { useEffect, useRef, useState } from "react";
import { FolderPlus, HardDrive, TriangleAlert, Upload } from "lucide-react";
import { FolderField, hostLabel, hostSources, type Source, SourceRail } from "./AccountParts";
import { type ChosenFolder, type CreateRequest, type HostAccount, hostAccounts, listNamespaces, type Namespace } from "./ipc";
import { validRepoName } from "./lib/repos";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** The branch the new repository starts on (the setting for new repositories). */
  defaultBranch: string;
  onCreate: (request: CreateRequest) => void;
  onProfiles: () => void;
  onClose: () => void;
}

const LOCAL: Source = { id: "local", label: "Local only", icon: HardDrive };

/** Creates a repository in a folder, optionally on GitHub or GitLab as well, with the first commit pushed. */
export function CreateRepoDialog({ defaultBranch, onCreate, onProfiles, onClose }: Props) {
  const [accounts, setAccounts] = useState<HostAccount[]>([]);
  const [source, setSource] = useState("local");
  const [folder, setFolder] = useState<ChosenFolder | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [readme, setReadme] = useState(true);
  const [isPrivate, setIsPrivate] = useState(true);
  const [owners, setOwners] = useState<Record<string, Namespace[] | string>>({});
  const asked = useRef(new Set<string>());
  const [owner, setOwner] = useState("");

  useEffect(() => {
    hostAccounts().then(setAccounts, () => undefined);
  }, []);

  const account = accounts.find((a) => a.host === source) ?? null;
  const hostOwners = account ? owners[account.host] : undefined;

  useEffect(() => {
    if (!account || !account.signed_in || asked.current.has(account.host)) return;
    asked.current.add(account.host);
    const host = account.host;
    listNamespaces(host).then(
      (list) => setOwners((o) => ({ ...o, [host]: list })),
      (e) => setOwners((o) => ({ ...o, [host]: String(e).replace(/^Error:\s*/, "") })),
    );
  }, [account]);

  const select = (id: string) => {
    setSource(id);
    setOwner("");
  };

  const publishing = !!account;
  const nameOk = name.trim().length > 0 && (publishing ? validRepoName(name) : true);
  const signedIn = !publishing || account.signed_in;
  const ready = !!folder && nameOk && signedIn && (!publishing || Array.isArray(hostOwners));

  const submit = () => {
    if (!ready || !folder) return;
    const personal = Array.isArray(hostOwners) ? hostOwners.find((n) => n.personal)?.path : undefined;
    onCreate({
      name: name.trim(),
      description: description.trim(),
      readme,
      defaultBranch: defaultBranch.trim() || null,
      folder: folder.id,
      publish: account ? { host: account.host, private: isPrivate, namespace: owner && owner !== personal ? owner : null } : null,
    });
  };

  return (
    <Dialog
      title="Create a repository"
      width={780}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={publishing ? Upload : FolderPlus} disabled={!ready}>
            {account ? `Create and publish to ${hostLabel(account.host)}` : "Create the repository"}
          </Button>
        </>
      }
    >
      <div className="rail-layout">
        <SourceRail sources={[LOCAL, ...hostSources(accounts)]} active={source} onSelect={select} />
        <div className="rail-main dialog-body">
          <FolderField label="Where to create it" folder={folder} onChange={setFolder} />
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            spellCheck={false}
            data-autofocus=""
            hint={
              publishing && name.trim() && !validRepoName(name)
                ? "Use letters, numbers, dots, dashes and underscores (no spaces), and do not start with a dash or dot."
                : "A folder with this name is made inside the folder above."
            }
          />
          <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={350} />

          {account && !account.signed_in && (
            <div className="callout callout-warn" role="note">
              <TriangleAlert size={16} />
              <div>
                <p>Sign in to {hostLabel(account.host)} to publish there.</p>
                <Button type="button" size="sm" onClick={onProfiles}>
                  Manage profiles
                </Button>
              </div>
            </div>
          )}

          {account?.signed_in && typeof hostOwners === "string" && (
            <div className="callout callout-warn" role="alert">
              <TriangleAlert size={16} />
              <p>{hostOwners}</p>
            </div>
          )}

          {account?.signed_in && Array.isArray(hostOwners) && (
            <>
              <div className="field">
                <label htmlFor="create-owner">Owner</label>
                <select
                  id="create-owner"
                  className="select"
                  value={owner || (hostOwners.find((n) => n.personal)?.path ?? "")}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  {hostOwners.map((n) => (
                    <option key={n.path} value={n.path}>
                      {n.personal ? `${n.path} (you)` : n.path}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" role="radiogroup" aria-label="Visibility">
                <label>Visibility</label>
                <label className="check-row">
                  <input type="radio" name="visibility" checked={isPrivate} onChange={() => setIsPrivate(true)} /> Private: only you and people you add can see it
                </label>
                <label className="check-row">
                  <input type="radio" name="visibility" checked={!isPrivate} onChange={() => setIsPrivate(false)} /> Public: anyone can see it
                </label>
              </div>
            </>
          )}

          <label className="check-row">
            <input type="checkbox" checked={readme} onChange={(e) => setReadme(e.target.checked)} /> Start with a README
          </label>
          <p className="muted small">
            {publishing
              ? "The repository is created here first, then on the host, and the first commit is pushed to it."
              : "A repository on this computer only. You can add a remote and push it later."}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
