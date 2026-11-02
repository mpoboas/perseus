/** Turns slash-separated ref names (`feature/ui/x`) into a folder tree for the sidebar. */

export interface RefLeaf<T> {
  type: "leaf";
  /** Last path segment. */
  label: string;
  /** The full ref name. */
  name: string;
  item: T;
}

export interface RefFolder<T> {
  type: "folder";
  label: string;
  /** Path of the folder, used as a stable key. */
  path: string;
  children: RefNode<T>[];
  /** Number of leaves below this folder. */
  count: number;
}

export type RefNode<T> = RefLeaf<T> | RefFolder<T>;

export function buildRefTree<T extends { name: string }>(items: readonly T[]): RefNode<T>[] {
  const root: RefFolder<T> = { type: "folder", label: "", path: "", children: [], count: 0 };
  for (const item of items) {
    const parts = item.name.split("/");
    let folder = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = folder.children.find((c): c is RefFolder<T> => c.type === "folder" && c.path === path);
      if (!next) {
        next = { type: "folder", label: parts[i], path, children: [], count: 0 };
        folder.children.push(next);
      }
      next.count++;
      folder = next;
    }
    folder.children.push({ type: "leaf", label: parts[parts.length - 1], name: item.name, item });
  }
  sortNodes(root.children);
  return root.children;
}

function sortNodes<T>(nodes: RefNode<T>[]) {
  // Folders first, then leaves, each alphabetically.
  nodes.sort((a, b) =>
    a.type === b.type ? a.label.localeCompare(b.label) : a.type === "folder" ? -1 : 1,
  );
  for (const n of nodes) if (n.type === "folder") sortNodes(n.children);
}
