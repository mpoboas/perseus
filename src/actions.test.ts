import { describe, expect, it } from "vitest";
import { type Endpoint, type Head, dropActions, menuActions } from "./actions";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const head: Head = { branch: "main", oid: A };

const main: Endpoint = { type: "ref", name: "main", kind: "branch", oid: A, isHead: true };
const feature: Endpoint = { type: "ref", name: "feature/x", kind: "branch", oid: B, isHead: false };
const remote: Endpoint = { type: "ref", name: "origin/topic", kind: "remote", oid: C, isHead: false };
const tag: Endpoint = { type: "ref", name: "v1", kind: "tag", oid: C, isHead: false };
const headCommit: Endpoint = { type: "commit", oid: A, summary: "tip" };
const otherCommit: Endpoint = { type: "commit", oid: B, summary: "Fix the thing" };

const ids = (r: { actions: { id: string }[] }) => r.actions.map((a) => a.id);

describe("dropActions", () => {
  it("merges a branch dropped onto the checked-out branch or its tip commit", () => {
    for (const target of [main, headCommit]) {
      const r = dropActions(feature, target, head);
      expect(ids(r)).toEqual(["merge"]);
      expect(r.actions[0].run).toEqual({ type: "git", op: { op: "merge", rev: "feature/x" } });
      expect(r.actions[0].danger).toBeFalsy();
    }
  });

  it("can merge remote branches and tags dropped on HEAD", () => {
    expect(dropActions(remote, main, head).actions[0].run).toEqual({
      type: "git",
      op: { op: "merge", rev: "origin/topic" },
    });
    expect(ids(dropActions(tag, main, head))).toEqual(["merge"]);
  });

  it("rebases the checked-out branch onto whatever it is dropped on, and warns", () => {
    const onBranch = dropActions(main, feature, head);
    expect(onBranch.actions[0].run).toEqual({ type: "git", op: { op: "rebase", onto: "feature/x" } });
    expect(onBranch.actions[0].danger).toBe(true);
    expect(onBranch.actions[0].warning).toMatch(/rewrites history/i);

    const onCommit = dropActions(main, otherCommit, head);
    expect(onCommit.actions[0].run).toEqual({ type: "git", op: { op: "rebase", onto: B } });
  });

  it("cherry-picks a commit dropped on the checked-out branch", () => {
    const r = dropActions(otherCommit, main, head);
    expect(ids(r)).toEqual(["cherry-pick"]);
    expect(r.actions[0].run).toEqual({ type: "git", op: { op: "cherry_pick", oid: B } });
    expect(r.actions[0].description).toContain("Fix the thing");
  });

  it("does nothing when dropped on itself, and says nothing about it", () => {
    expect(dropActions(feature, feature, head)).toEqual({ actions: [], reason: null });
    expect(dropActions(headCommit, headCommit, head)).toEqual({ actions: [], reason: null });
  });

  it("refuses gestures that do not involve HEAD, with an explanation", () => {
    const elsewhere: Endpoint = { type: "commit", oid: C, summary: "unrelated" };
    for (const [s, t] of [
      [feature, remote],
      [otherCommit, feature],
      [otherCommit, elsewhere],
    ] as [Endpoint, Endpoint][]) {
      const r = dropActions(s, t, head);
      expect(r.actions).toEqual([]);
      expect(r.reason).toMatch(/checked-out branch/);
    }
  });

  it("never cherry-picks HEAD onto itself or merges HEAD into HEAD", () => {
    expect(dropActions(headCommit, main, head).actions).toEqual([]);
    expect(dropActions(main, headCommit, head).actions).toEqual([]);
  });

  it("works on a detached HEAD: merge and cherry-pick still apply, rebase does not", () => {
    const detached: Head = { branch: null, oid: A };
    expect(ids(dropActions(feature, headCommit, detached))).toEqual(["merge"]);
    expect(ids(dropActions(otherCommit, headCommit, detached))).toEqual(["cherry-pick"]);
    expect(dropActions(headCommit, feature, detached).actions).toEqual([]);
  });
});

describe("menuActions", () => {
  it("offers checkout, merge, rebase, branch and copy for another branch", () => {
    expect(menuActions(feature, head).map((a) => a.id)).toEqual([
      "checkout",
      "merge",
      "rebase",
      "rename-branch",
      "create-pr",
      "delete-branch",
      "force-delete-branch",
      "new-tag",
      "new-annotated-tag",
      "interactive-rebase",
      "reset-soft",
      "reset-mixed",
      "reset-hard",
      "revert",
      "new-branch",
      "copy",
    ]);
  });

  it("checks out remote branches as local tracking branches and tags detached", () => {
    expect(menuActions(remote, head)[0].run).toEqual({
      type: "switch",
      target: { kind: "branch", name: "topic" },
    });
    expect(menuActions(tag, head)[0].run).toEqual({
      type: "switch",
      target: { kind: "detached", oid: C },
    });
    // Merging a tag is not offered from the menu.
    expect(menuActions(tag, head).map((a) => a.id)).not.toContain("merge");
  });

  it("never offers to delete, reset or check out the checked-out branch itself", () => {
    expect(menuActions(main, head).map((a) => a.id)).toEqual([
      "rename-branch",
      "create-pr",
      "new-tag",
      "new-annotated-tag",
      "revert",
      "new-branch",
      "copy",
    ]);
  });

  it("offers cherry-pick and rebase for other commits, but not for HEAD's own", () => {
    expect(menuActions(otherCommit, head).map((a) => a.id)).toEqual([
      "checkout",
      "cherry-pick",
      "rebase",
      "new-tag",
      "new-annotated-tag",
      "interactive-rebase",
      "reset-soft",
      "reset-mixed",
      "reset-hard",
      "revert",
      "new-branch",
      "copy",
    ]);
    expect(menuActions(headCommit, head).map((a) => a.id)).toEqual([
      "checkout",
      "new-tag",
      "new-annotated-tag",
      "revert",
      "new-branch",
      "copy",
    ]);
  });

  it("marks quick actions immediate and anything that changes history as confirmable", () => {
    const byId = Object.fromEntries(menuActions(otherCommit, head).map((a) => [a.id, a]));
    expect(byId.checkout.immediate).toBe(true);
    expect(byId.copy.immediate).toBe(true);
    expect(byId["cherry-pick"].immediate).toBeFalsy();
    expect(byId.rebase.danger).toBe(true);
    expect(byId["new-branch"].needsName).toBe(true);
    expect(byId["new-branch"].run).toEqual({ type: "new_branch", start: B });
  });

  it("skips merge and rebase when there is no HEAD commit at all (unborn branch)", () => {
    const unborn: Head = { branch: "main", oid: null };
    expect(menuActions(feature, unborn).map((a) => a.id)).toEqual([
      "checkout",
      "rename-branch",
      "create-pr",
      "delete-branch",
      "force-delete-branch",
      "new-tag",
      "new-annotated-tag",
      "revert",
      "new-branch",
      "copy",
    ]);
  });
});

describe("branch, tag, reset and revert entries", () => {
  const find = (e: Endpoint, id: string) => menuActions(e, head).find((a) => a.id === id)!;
  const run = (e: Endpoint, id: string, name = "") => {
    const r = find(e, id).run;
    if (r.type !== "action") throw new Error("not a quick action");
    return typeof r.action === "function" ? r.action(name) : r.action;
  };

  it("deleting is safe by default and force is a separate, warned step", () => {
    expect(run(feature, "delete-branch")).toEqual({ action: "branch_delete", name: "feature/x" });
    expect(find(feature, "delete-branch").danger).toBe(true);
    const force = find(feature, "force-delete-branch");
    expect(force.warning).toMatch(/unreachable/);
    expect(run(feature, "force-delete-branch")).toEqual({ action: "branch_delete", name: "feature/x", force: true });
  });

  it("renaming asks for a name, starting from the current one", () => {
    const rename = find(feature, "rename-branch");
    expect(rename.needsName).toBe(true);
    expect(rename.nameInitial).toBe("feature/x");
    expect(run(feature, "rename-branch", "feature/y")).toEqual({
      action: "branch_rename",
      old: "feature/x",
      new: "feature/y",
    });
  });

  it("splits a remote branch into remote and branch for deletion, and warns", () => {
    const del = find(remote, "delete-remote-branch");
    expect(del.warning).toBeTruthy();
    expect(run(remote, "delete-remote-branch")).toEqual({
      action: "branch_delete_remote",
      remote: "origin",
      name: "topic",
    });
  });

  it("offers tag push and delete for tags, but no reset or tag-here on a tag", () => {
    const ids = menuActions(tag, head).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["push-tag", "delete-tag", "delete-remote-tag"]));
    expect(ids).not.toContain("new-tag");
    expect(ids).not.toContain("new-annotated-tag");
    expect(run(tag, "delete-remote-tag")).toEqual({ action: "tag_delete_remote", name: "v1" });
  });

  it("creates a tag at the clicked commit", () => {
    expect(run(otherCommit, "new-tag", "v2")).toEqual({ action: "tag_create", name: "v2", target: B });
  });

  it("only the hard reset is dangerous, and it explains what is lost", () => {
    expect(find(otherCommit, "reset-soft").danger).toBeFalsy();
    expect(find(otherCommit, "reset-mixed").danger).toBeFalsy();
    const hard = find(otherCommit, "reset-hard");
    expect(hard.danger).toBe(true);
    expect(hard.warning).toMatch(/Uncommitted changes/);
    expect(run(otherCommit, "reset-hard")).toEqual({ action: "reset", mode: "hard", target: B });
  });

  it("reverting a merge commit picks the first parent as mainline", () => {
    const merge: Endpoint = { type: "commit", oid: B, summary: "Merge x", parents: 2 };
    expect(run(merge, "revert")).toEqual({ action: "revert", oid: B, mainline: 1 });
    expect(run(otherCommit, "revert")).toEqual({ action: "revert", oid: B, mainline: null });
  });
});

describe("annotated tags", () => {
  it("carry the tag name as their message", () => {
    const a = menuActions({ type: "commit", oid: "b".repeat(40), summary: "x" }, { branch: "main", oid: "a".repeat(40) }).find(
      (x) => x.id === "new-annotated-tag",
    );
    const act = a?.run.type === "action" && typeof a.run.action === "function" ? a.run.action("v3") : null;
    expect(act).toEqual({ action: "tag_create", name: "v3", target: "b".repeat(40), message: "v3" });
  });
});
