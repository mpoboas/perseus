/**
 * What dragging one thing onto another (or right-clicking it) means in git terms.
 *
 * Merge, rebase and cherry-pick always act on the checked-out branch, so every
 * rule is phrased relative to HEAD. When a gesture does not involve HEAD we say
 * so instead of silently switching branches under the user.
 */
import type { GitOp, RefInfo, SwitchTarget } from "./ipc";

export interface Head {
  /** Checked-out branch, or null on a detached HEAD. */
  branch: string | null;
  /** The commit HEAD points at. */
  oid: string | null;
}

export type Endpoint =
  | { type: "ref"; name: string; kind: RefInfo["kind"]; oid: string; isHead: boolean }
  | { type: "commit"; oid: string; summary: string };

export type ActionRun =
  | { type: "git"; op: GitOp }
  | { type: "switch"; target: SwitchTarget }
  | { type: "new_branch"; start: string }
  | { type: "copy"; text: string };

export interface GraphAction {
  id: string;
  title: string;
  description: string;
  /** Shown prominently in the confirm dialog (history rewrites, etc.). */
  warning?: string;
  confirmLabel: string;
  /** Skip the confirm dialog (checkout and copy are immediate and easily undone). */
  immediate?: boolean;
  danger?: boolean;
  /** The dialog asks for a branch name. */
  needsName?: boolean;
  run: ActionRun;
}

const short = (oid: string) => oid.slice(0, 7);

const headLabel = (head: Head) => head.branch ?? "the detached HEAD";

/** The ref name when there is one, else the commit id: what git is told to merge or rebase onto. */
function revOf(e: Endpoint): string {
  return e.type === "ref" ? e.name : e.oid;
}

function describe(e: Endpoint): string {
  return e.type === "ref" ? `'${e.name}'` : `commit ${short(e.oid)}`;
}

function sameThing(a: Endpoint, b: Endpoint): boolean {
  if (a.type === "ref" && b.type === "ref") return a.name === b.name;
  if (a.type === "commit" && b.type === "commit") return a.oid === b.oid;
  return false;
}

/** True when `e` is the checked-out branch, or the commit at its tip. */
function isHead(e: Endpoint, head: Head): boolean {
  if (e.type === "ref") return e.isHead;
  return head.oid !== null && e.oid === head.oid;
}

const merge = (src: Endpoint, head: Head): GraphAction => ({
  id: "merge",
  title: `Merge ${describe(src)} into ${headLabel(head)}`,
  description:
    "Brings the commits of " +
    `${describe(src)} into ${headLabel(head)}. Git fast-forwards when it can and otherwise ` +
    "creates a merge commit. If there are conflicts you can resolve them or abort from the Changes tab.",
  confirmLabel: "Merge",
  run: { type: "git", op: { op: "merge", rev: revOf(src) } },
});

const rebase = (target: Endpoint, head: Head): GraphAction => ({
  id: "rebase",
  title: `Rebase ${headLabel(head)} onto ${describe(target)}`,
  description:
    `Replays the commits of ${headLabel(head)} on top of ${describe(target)}, giving them new ids.`,
  warning:
    "This rewrites history. Avoid it if these commits have already been pushed and shared with others.",
  confirmLabel: "Rebase",
  danger: true,
  run: { type: "git", op: { op: "rebase", onto: revOf(target) } },
});

const cherryPick = (src: Extract<Endpoint, { type: "commit" }>, head: Head): GraphAction => ({
  id: "cherry-pick",
  title: `Cherry-pick ${short(src.oid)} onto ${headLabel(head)}`,
  description: `Copies the changes introduced by "${src.summary}" as a new commit on ${headLabel(head)}.`,
  confirmLabel: "Cherry-pick",
  run: { type: "git", op: { op: "cherry_pick", oid: src.oid } },
});

const NEEDS_HEAD =
  "Merge, rebase and cherry-pick act on the checked-out branch. Drop onto it, or check out one of these first.";

/** Everything a drop of `source` onto `target` could mean. Empty means "not possible", with a reason. */
export function dropActions(
  source: Endpoint,
  target: Endpoint,
  head: Head,
): { actions: GraphAction[]; reason: string | null } {
  if (sameThing(source, target)) return { actions: [], reason: null };

  const actions: GraphAction[] = [];
  const sourceIsHeadBranch = source.type === "ref" && source.isHead;

  if (isHead(target, head)) {
    // Bring something into the current branch.
    if (source.type === "ref" && !source.isHead) actions.push(merge(source, head));
    if (source.type === "commit" && source.oid !== head.oid) {
      actions.push(cherryPick(source, head));
    }
  } else if (sourceIsHeadBranch) {
    // Move the current branch on top of something else.
    actions.push(rebase(target, head));
  }

  return { actions, reason: actions.length ? null : NEEDS_HEAD };
}

/** Branch to check out for a ref: remote `origin/topic` becomes local `topic` (git sets up tracking). */
function checkoutTarget(e: Extract<Endpoint, { type: "ref" }>): SwitchTarget {
  if (e.kind === "tag") return { kind: "detached", oid: e.oid };
  const name = e.kind === "remote" ? e.name.split("/").slice(1).join("/") : e.name;
  return { kind: "branch", name };
}

/** Entries for the right-click menu on a ref badge or commit row. */
export function menuActions(subject: Endpoint, head: Head): GraphAction[] {
  const out: GraphAction[] = [];
  const oid = subject.oid;
  const hasHead = head.oid !== null;

  if (subject.type === "ref") {
    if (!subject.isHead) {
      out.push({
        id: "checkout",
        title: subject.kind === "tag" ? `Check out ${describe(subject)} (detached)` : `Check out ${describe(subject)}`,
        description: "",
        confirmLabel: "Check out",
        immediate: true,
        run: { type: "switch", target: checkoutTarget(subject) },
      });
      if (hasHead && subject.kind !== "tag") out.push(merge(subject, head));
      if (hasHead && head.branch) out.push(rebase(subject, head));
    }
  } else {
    out.push({
      id: "checkout",
      title: `Check out commit ${short(oid)} (detached)`,
      description: "",
      confirmLabel: "Check out",
      immediate: true,
      run: { type: "switch", target: { kind: "detached", oid } },
    });
    if (hasHead && oid !== head.oid) {
      out.push(cherryPick(subject, head));
      if (head.branch) out.push(rebase(subject, head));
    }
  }

  out.push({
    id: "new-branch",
    title: `Create branch here…`,
    description: `Starts a new branch at ${subject.type === "ref" ? describe(subject) : `commit ${short(oid)}`} and checks it out.`,
    confirmLabel: "Create branch",
    needsName: true,
    run: { type: "new_branch", start: oid },
  });
  out.push({
    id: "copy",
    title: "Copy commit id",
    description: "",
    confirmLabel: "Copy",
    immediate: true,
    run: { type: "copy", text: oid },
  });
  return out;
}
