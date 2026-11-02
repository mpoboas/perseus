import type { GraphAction } from "./actions";
import type { MenuItem } from "./ui";

/**
 * Right-click menus are built from a flat list of actions. This puts them in the order people
 * expect, draws a divider between kinds of entries, and folds the three resets into a flyout.
 *
 * Groups, top to bottom: switch / sync, worktree, change history, copy and export, tags, graph view.
 */
const GROUP_OF: Record<string, number> = {
  checkout: 0,
  "pull-head": 0,
  "push-head": 0,
  "new-worktree": 1,
  copy: 3,
  "copy-branch": 3,
  "copy-link": 3,
  "copy-link-branch": 3,
  patch: 3,
  "new-tag": 4,
  "new-annotated-tag": 4,
  "push-tag": 4,
  "delete-tag": 4,
  "delete-remote-tag": 4,
  "hide-ref": 5,
  "solo-ref": 5,
  "clear-filter": 5,
};

/** Order inside the "change history" group; anything not listed keeps its place after these. */
const HISTORY_ORDER = [
  "new-branch",
  "cherry-pick",
  "merge",
  "rebase",
  "interactive-rebase",
  "reset",
  "revert",
  "rename-branch",
  "create-pr",
  "delete-branch",
  "force-delete-branch",
  "delete-remote-branch",
];

const RESET_LABEL: Record<string, string> = {
  "reset-soft": "Soft – keep all changes",
  "reset-mixed": "Mixed – keep working copy but reset index",
  "reset-hard": "Hard – discard all changes",
};

const groupOf = (id: string) => GROUP_OF[id] ?? 2;

export function layoutMenu(actions: GraphAction[], headLabel: string | null): MenuItem[] {
  const resets = actions.filter((a) => a.id in RESET_LABEL);
  const rest = actions.filter((a) => !(a.id in RESET_LABEL));

  type Entry = { group: number; rank: number; seq: number; item: MenuItem };
  const entries: Entry[] = rest.map((a, seq) => {
    const group = groupOf(a.id);
    const rank = group === 2 ? HISTORY_ORDER.indexOf(a.id) : -1;
    return { group, rank: rank < 0 ? HISTORY_ORDER.length : rank, seq, item: { id: a.id, label: a.title, danger: a.danger } };
  });

  if (resets.length) {
    entries.push({
      group: 2,
      rank: HISTORY_ORDER.indexOf("reset"),
      seq: rest.length,
      item: {
        id: "reset",
        label: `Reset ${headLabel ?? "HEAD"} to this commit`,
        submenu: resets.map((a) => ({ id: a.id, label: RESET_LABEL[a.id], danger: a.id === "reset-hard" })),
      },
    });
  }

  entries.sort((a, b) => a.group - b.group || a.rank - b.rank || a.seq - b.seq);

  const out: MenuItem[] = [];
  let last = -1;
  for (const e of entries) {
    if (last !== -1 && e.group !== last) out.push({ id: `sep-${e.group}`, separator: true });
    out.push(e.item);
    last = e.group;
  }
  return out;
}
