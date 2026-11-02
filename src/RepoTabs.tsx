import { FolderGit2, Plus, X } from "lucide-react";
import { IconButton } from "./ui";

export interface Tab {
  path: string;
  name: string;
}

interface Props {
  tabs: Tab[];
  activePath: string | null;
  onSelect: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
  onNew: () => void;
}

/** One tab per repository the user keeps open. Switching reopens it; sizes and picks are remembered. */
export function RepoTabs({ tabs, activePath, onSelect, onClose, onNew }: Props) {
  return (
    <div className="repo-tabs" role="tablist" aria-label="Open repositories">
      {tabs.map((t) => (
        <div key={t.path} className={t.path === activePath ? "repo-tab active" : "repo-tab"}>
          <button
            role="tab"
            aria-selected={t.path === activePath}
            className="repo-tab-main"
            title={t.path}
            onClick={() => onSelect(t)}
          >
            <FolderGit2 size={13} />
            <span>{t.name}</span>
          </button>
          <button className="repo-tab-close" aria-label={`Close ${t.name}`} onClick={() => onClose(t)}>
            <X size={12} />
          </button>
        </div>
      ))}
      <IconButton icon={Plus} label="Open another repository" size="sm" onClick={onNew} />
    </div>
  );
}
