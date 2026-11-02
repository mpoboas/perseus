import type { RefInfo } from "../ipc";

const MAIN_NAMES = ["main", "master"];

export type Comparison =
  | { kind: "target"; ref: string; headOid: string; targetOid: string }
  /** Nothing to compare, with the reason to show. */
  | { kind: "none"; reason: string };

/** `origin/main` → `main`. */
const tail = (name: string) => name.split("/").slice(1).join("/");

/**
 * The branch the current one is checked against: the remote's main branch (or the local one when
 * there is no remote). A repository whose current branch is that main branch has nothing to compare.
 */
export function conflictTarget(refs: RefInfo[], branch: string | null): Comparison {
  const head = refs.find((r) => r.kind === "branch" && r.is_head);
  if (!branch || !head) return { kind: "none", reason: "Conflict detection needs a checked-out branch" };

  const remotes = refs.filter((r) => r.kind === "remote" && !r.name.endsWith("/HEAD"));
  // Prefer `origin`, then whichever remote there is.
  const remoteNames = [...new Set(remotes.map((r) => r.name.split("/")[0]))].sort((a, b) =>
    a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b),
  );
  const candidates = [
    ...remoteNames.flatMap((remote) => MAIN_NAMES.map((m) => `${remote}/${m}`)),
    ...MAIN_NAMES,
  ];
  const target = candidates
    .map((name) => refs.find((r) => r.name === name && (r.kind === "remote" || r.kind === "branch")))
    .find((r): r is RefInfo => !!r);
  if (!target) return { kind: "none", reason: "No main branch to compare against" };

  const mainName = target.kind === "remote" ? tail(target.name) : target.name;
  if (branch === mainName) return { kind: "none", reason: `This is the main branch (${branch})` };
  return { kind: "target", ref: target.name, headOid: head.target, targetOid: target.target };
}
