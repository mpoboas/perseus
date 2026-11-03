import { describe, expect, it } from "vitest";
import type { CommitRow } from "../ipc";
import { describeCommit, describeWip, mirroredRows } from "./graphA11y";

const row = (over: Partial<CommitRow>): CommitRow => ({
  oid: "a".repeat(40),
  parents: ["b".repeat(40)],
  author: "Ada",
  author_email: "ada@example.com",
  time: 1_700_000_000,
  summary: "Fix the thing",
  refs: [],
  graph: {} as CommitRow["graph"],
  ...over,
});

describe("describeCommit", () => {
  it("says the message, the author and the date", () => {
    const text = describeCommit(row({}), new Map());
    expect(text).toMatch(/^Fix the thing, by Ada, /);
  });

  it("names branches, tags, remotes and the checked-out commit", () => {
    const kinds = new Map([
      ["main", "branch"],
      ["v1", "tag"],
      ["origin/main", "remote"],
    ] as const);
    const text = describeCommit(row({ refs: ["HEAD", "main", "v1", "origin/main"] }), kinds);
    expect(text).toContain("checked out, branch main, tag v1, remote branch origin/main");
  });

  it("tells merges and the first commit apart", () => {
    expect(describeCommit(row({ parents: ["x", "y"] }), new Map())).toContain("merge of 2 commits");
    expect(describeCommit(row({ parents: [] }), new Map())).toContain("first commit");
  });

  it("copes with an empty message", () => {
    expect(describeCommit(row({ summary: "" }), new Map())).toMatch(/^No message,/);
  });
});

describe("describeWip", () => {
  it("counts files", () => {
    expect(describeWip(0)).toBe("No uncommitted changes");
    expect(describeWip(1)).toBe("Uncommitted changes in 1 file");
    expect(describeWip(3)).toBe("Uncommitted changes in 3 files");
  });
});

describe("mirroredRows", () => {
  it("covers the visible rows with a margin, clipped to the list", () => {
    expect(mirroredRows(10, 12, null, 100)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(mirroredRows(0, 2, null, 3)).toEqual([0, 1, 2]);
  });

  it("keeps the selected row even when it is scrolled out of sight", () => {
    expect(mirroredRows(50, 52, 3, 100)).toContain(3);
    expect(mirroredRows(50, 52, 500, 100)).not.toContain(500);
  });
});
