import { useState } from "react";
import { FolderGit2, Pencil, Plus, Star, X } from "lucide-react";
import type { RecentRepo } from "./ipc";
import { tabLabel } from "./lib/repos";
import { IconButton, Menu, type MenuItem } from "./ui";

export interface Tab {
  path: string;
  name: string;
}

interface Props {
  tabs: Tab[];
  activePath: string | null;
  /** The recent list, which knows each repository's alias and whether it is a favorite. */
  recents: RecentRepo[];
  onSelect: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
  onCloseOthers: (tab: Tab) => void;
  onRename: (tab: Tab) => void;
  onToggleFavorite: (tab: Tab, favorite: boolean) => void;
  onNew: () => void;
}

/** One tab per repository the user keeps open. Switching reopens it; sizes and picks are remembered. */
export function RepoTabs({ tabs, activePath, recents, onSelect, onClose, onCloseOthers, onRename, onToggleFavorite, onNew }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const favorite = (tab: Tab) => recents.some((r) => r.path === tab.path && r.favorite);

  const items = (tab: Tab): MenuItem[] => [
    { id: "rename", label: "Rename…", icon: Pencil },
    { id: "favorite", label: favorite(tab) ? "Remove from favorites" : "Add to favorites", icon: Star },
    { id: "sep", separator: true },
    { id: "close", label: "Close", icon: X },
    { id: "others", label: "Close other tabs", disabled: tabs.length < 2 },
  ];

  return (
    <div className="repo-tabs" role="tablist" aria-label="Open repositories">
      {tabs.map((t) => {
        const label = tabLabel(t, recents);
        return (
          <div
            key={t.path}
            className={t.path === activePath ? "repo-tab active" : "repo-tab"}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tab: t });
            }}
          >
            <button
              role="tab"
              aria-selected={t.path === activePath}
              className="repo-tab-main"
              title={label === t.name ? t.path : `${t.name} — ${t.path}`}
              onClick={() => onSelect(t)}
              onDoubleClick={() => onRename(t)}
            >
              {favorite(t) ? <Star size={13} className="tab-star" /> : <FolderGit2 size={13} />}
              <span>{label}</span>
            </button>
            <button className="repo-tab-close" aria-label={`Close ${label}`} onClick={() => onClose(t)}>
              <X size={12} />
            </button>
          </div>
        );
      })}
      <IconButton icon={Plus} label="Open another repository" size="sm" onClick={onNew} />
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          items={items(menu.tab)}
          onClose={() => setMenu(null)}
          onPick={(id) => {
            const tab = menu.tab;
            setMenu(null);
            if (id === "rename") onRename(tab);
            else if (id === "favorite") onToggleFavorite(tab, !favorite(tab));
            else if (id === "close") onClose(tab);
            else if (id === "others") onCloseOthers(tab);
          }}
        />
      )}
    </div>
  );
}
