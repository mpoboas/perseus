/**
 * What dragging one thing onto another (or right-clicking it) means in git terms.
 *
 * Merge, rebase and cherry-pick always act on the checked-out branch, so every
 * rule is phrased relative to HEAD. When a gesture does not involve HEAD we say
 * so instead of silently switching branches under the user.
 */
import type { GitAction, GitOp, RefInfo, SwitchTarget } from "./ipc";

export interface Head {
  /** Checked-out branch, or null on a detached HEAD. */
  branch: string | null;
  /** The commit HEAD points at. */
  oid: string | null;
}

export type Endpoint =
  | { type: "ref"; name: string; kind: RefInfo["kind"]; oid: string; isHead: boolean; parents?: number }
  | { type: "commit"; oid: string; summary: string; parents?: number };

export type ActionRun =
  | { type: "git"; op: GitOp }
  | { type: "switch"; target: SwitchTarget }
  | { type: "new_branch"; start: string }
  /** A quick action; a function receives the name the user typed in the dialog. */
  | { type: "action"; action: GitAction | ((name: string) => GitAction) }
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
  /** The dialog asks for a name (a new branch by default). */
  needsName?: boolean;
  nameLabel?: string;
  /** Pre-filled value, e.g. the current name when renaming. */
  nameInitial?: string;
  namePlaceholder?: string;
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

  out.push(...manageActions(subject, head));
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

const act = (a: GitAction): GraphAction["run"] => ({ type: "action", action: a });

/** Branch, tag, reset and revert entries for the right-click menu. */
export function manageActions(subject: Endpoint, head: Head): GraphAction[] {
  const out: GraphAction[] = [];
  const oid = subject.oid;

  if (subject.type === "ref") {
    if (subject.kind === "branch") {
      out.push({
        id: "rename-branch",
        title: `Rename ${describe(subject)}…`,
        description: `Gives the local branch ${describe(subject)} a new name. Its commits and upstream stay as they are.`,
        confirmLabel: "Rename",
        needsName: true,
        nameLabel: "New name",
        nameInitial: subject.name,
        run: {
          type: "action",
          action: (n) => ({ action: "branch_rename", old: subject.name, new: n }),
        },
      });
      if (!subject.isHead) {
        out.push({
          id: "delete-branch",
          title: `Delete branch ${describe(subject)}`,
          description: `Removes the local branch ${describe(subject)}. Git refuses when it holds commits that are not merged anywhere else.`,
          confirmLabel: "Delete",
          danger: true,
          run: act({ action: "branch_delete", name: subject.name }),
        });
        out.push({
          id: "force-delete-branch",
          title: `Force delete ${describe(subject)}…`,
          description: `Deletes ${describe(subject)} even if it has unmerged commits.`,
          warning:
            "Commits that only this branch contains become unreachable. You can still find them in the reflog for a while, but they will no longer show in the graph.",
          confirmLabel: "Force delete",
          danger: true,
          run: act({ action: "branch_delete", name: subject.name, force: true }),
        });
      }
    } else if (subject.kind === "remote") {
      const [remote, ...rest] = subject.name.split("/");
      const branch = rest.join("/");
      if (remote && branch) {
        out.push({
          id: "delete-remote-branch",
          title: `Delete ${describe(subject)} on the remote…`,
          description: `Deletes the branch ${branch} from ${remote} itself, for everyone who uses it.`,
          warning: "This changes the remote repository and cannot be undone from here.",
          confirmLabel: "Delete on remote",
          danger: true,
          run: act({ action: "branch_delete_remote", remote, name: branch }),
        });
      }
    } else if (subject.kind === "tag") {
      out.push({
        id: "push-tag",
        title: `Push tag ${describe(subject)} to origin`,
        description: `Publishes the tag ${describe(subject)} to the remote called origin.`,
        confirmLabel: "Push tag",
        run: act({ action: "tag_push", name: subject.name }),
      });
      out.push({
        id: "delete-tag",
        title: `Delete tag ${describe(subject)}`,
        description: `Removes the tag ${describe(subject)} from this repository. A copy on the remote is not touched.`,
        confirmLabel: "Delete tag",
        danger: true,
        run: act({ action: "tag_delete", name: subject.name }),
      });
      out.push({
        id: "delete-remote-tag",
        title: `Delete tag ${describe(subject)} on origin…`,
        description: `Removes the tag from the remote called origin.`,
        warning: "This changes the remote repository.",
        confirmLabel: "Delete on origin",
        danger: true,
        run: act({ action: "tag_delete_remote", name: subject.name }),
      });
    }
  }

  const here = subject.type === "ref" ? describe(subject) : `commit ${short(oid)}`;
  if (!(subject.type === "ref" && subject.kind === "tag")) {
    out.push({
      id: "new-tag",
      title: "Create tag here…",
      description: `Adds a tag at ${here}. Tags are stored in this repository; push them to share.`,
      confirmLabel: "Create tag",
      needsName: true,
      nameLabel: "Tag name",
      namePlaceholder: "v1.0.0",
      run: { type: "action", action: (n) => ({ action: "tag_create", name: n, target: oid }) },
    });
  }

  if (head.branch && head.oid !== null && oid !== head.oid) {
    const onto = `${headLabel(head)} to ${here}`;
    out.push({
      id: "reset-soft",
      title: `Reset ${headLabel(head)} to here (soft)`,
      description: `Moves ${onto}. Every change after it stays staged, ready to commit again.`,
      confirmLabel: "Reset (soft)",
      run: act({ action: "reset", mode: "soft", target: oid }),
    });
    out.push({
      id: "reset-mixed",
      title: `Reset ${headLabel(head)} to here (mixed)`,
      description: `Moves ${onto}. Every change after it stays in your files, unstaged.`,
      confirmLabel: "Reset (mixed)",
      run: act({ action: "reset", mode: "mixed", target: oid }),
    });
    out.push({
      id: "reset-hard",
      title: `Reset ${headLabel(head)} to here (hard)…`,
      description: `Moves ${onto} and makes your files match it exactly.`,
      warning:
        "Uncommitted changes and every commit after this point are discarded from your working copy. Committed work can still be recovered through the reflog; uncommitted work cannot.",
      confirmLabel: "Reset (hard)",
      danger: true,
      run: act({ action: "reset", mode: "hard", target: oid }),
    });
  }

  if (subject.type === "commit" || (subject.type === "ref" && subject.kind !== "tag")) {
    const merge = (subject.parents ?? 1) > 1;
    out.push({
      id: "revert",
      title: `Revert ${here}`,
      description: merge
        ? `Creates a new commit that undoes the merge ${here}, keeping the first parent's side.`
        : `Creates a new commit on ${headLabel(head)} that undoes the changes of ${here}.`,
      confirmLabel: "Revert",
      run: act({ action: "revert", oid, mainline: merge ? 1 : null }),
    });
  }
  return out;
}
