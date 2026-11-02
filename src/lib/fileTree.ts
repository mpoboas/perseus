/** Groups a flat list of changed files into folders for the "tree" view of a commit's files. */

export interface FileLeaf<T> {
  type: "file";
  name: string;
  item: T;
}

export interface FileDir<T> {
  type: "dir";
  /** Display name; single-child chains are merged (`src/ui`). */
  name: string;
  path: string;
  children: FileNode<T>[];
  count: number;
}

export type FileNode<T> = FileLeaf<T> | FileDir<T>;

export function buildFileTree<T extends { path: string }>(items: readonly T[]): FileNode<T>[] {
  const root: FileDir<T> = { type: "dir", name: "", path: "", children: [], count: 0 };
  for (const item of items) {
    const parts = item.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.children.find((c): c is FileDir<T> => c.type === "dir" && c.path === path);
      if (!next) {
        next = { type: "dir", name: parts[i], path, children: [], count: 0 };
        dir.children.push(next);
      }
      next.count++;
      dir = next;
    }
    dir.children.push({ type: "file", name: parts[parts.length - 1], item });
  }
  return finish(root.children);
}

function finish<T>(nodes: FileNode<T>[]): FileNode<T>[] {
  const out = nodes.map((n) => {
    if (n.type === "file") return n;
    let dir: FileDir<T> = { ...n, children: finish(n.children) };
    // Merge `a` → `b` into `a/b` when a folder only holds another folder.
    while (dir.children.length === 1 && dir.children[0].type === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return dir;
  });
  out.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return out;
}
