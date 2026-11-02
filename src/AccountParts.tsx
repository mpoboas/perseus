import { type ComponentType, useEffect, useId } from "react";
import { Cat, Server, Triangle } from "lucide-react";
import { type ChosenFolder, chooseFolder, type HostAccount } from "./ipc";
import { Button } from "./ui";

type IconType = ComponentType<{ size?: number; className?: string }>;

export interface Source {
  id: string;
  label: string;
  icon: IconType;
}

/** The name people know a host by. */
export function hostLabel(host: string): string {
  if (host === "github.com") return "GitHub.com";
  if (host === "gitlab.com") return "GitLab.com";
  return host;
}

export function hostIcon(account: Pick<HostAccount, "kind">): IconType {
  return account.kind === "git_hub" ? Cat : account.kind === "git_lab" ? Triangle : Server;
}

/** One entry per host the profile can use, after the fixed ones ("Clone with URL", "Local only"). */
export function hostSources(accounts: HostAccount[]): Source[] {
  return accounts.map((a) => ({ id: a.host, label: hostLabel(a.host), icon: hostIcon(a) }));
}

/** The list down the left of the clone and create dialogs: where the repository comes from or goes to. */
export function SourceRail({ sources, active, onSelect }: { sources: Source[]; active: string; onSelect: (id: string) => void }) {
  return (
    <nav className="rail" role="tablist" aria-orientation="vertical" aria-label="Source">
      {sources.map((s) => (
        <button
          key={s.id}
          role="tab"
          aria-selected={s.id === active}
          className={s.id === active ? "rail-item active" : "rail-item"}
          onClick={() => onSelect(s.id)}
          type="button"
        >
          <s.icon size={16} className="rail-icon" />
          <span>{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * "Where to clone to": the folder is chosen in a native dialog (Browse), and starts as the one used last.
 * Only the native dialog can name a folder, so what the field shows is what will be used.
 */
export function FolderField({ label, folder, onChange }: { label: string; folder: ChosenFolder | null; onChange: (f: ChosenFolder) => void }) {
  const id = useId();
  useEffect(() => {
    if (folder) return;
    chooseFolder(false).then(
      (f) => f && onChange(f),
      () => undefined,
    );
    // Only the first time: the field then belongs to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const browse = () =>
    void chooseFolder(true).then(
      (f) => f && onChange(f),
      () => undefined,
    );

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row">
        <input id={id} className="input" readOnly value={folder?.path ?? ""} placeholder="Choose a folder…" onClick={browse} />
        <Button type="button" onClick={browse}>
          Browse
        </Button>
      </div>
    </div>
  );
}
