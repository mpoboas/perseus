import { describe, expect, it } from "vitest";
import type { RefInfo } from "../ipc";
import { conflictTarget } from "./conflicts";

const ref = (name: string, kind: RefInfo["kind"], target: string, is_head = false): RefInfo => ({
  name,
  kind,
  target,
  is_head,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
});

describe("conflictTarget", () => {
  it("compares a feature branch with the remote's main", () => {
    const refs = [ref("feature", "branch", "a1", true), ref("main", "branch", "b2"), ref("origin/main", "remote", "c3"), ref("origin/HEAD", "remote", "c3")];
    expect(conflictTarget(refs, "feature")).toEqual({ kind: "target", ref: "origin/main", headOid: "a1", targetOid: "c3" });
  });

  it("prefers origin, then main over master", () => {
    const refs = [ref("topic", "branch", "a", true), ref("upstream/main", "remote", "u"), ref("origin/master", "remote", "m"), ref("origin/main", "remote", "o")];
    expect(conflictTarget(refs, "topic")).toMatchObject({ ref: "origin/main" });
    const noMain = refs.filter((r) => r.name !== "origin/main");
    expect(conflictTarget(noMain, "topic")).toMatchObject({ ref: "origin/master" });
  });

  it("falls back to the local main branch when there is no remote", () => {
    const refs = [ref("topic", "branch", "a", true), ref("main", "branch", "b")];
    expect(conflictTarget(refs, "topic")).toMatchObject({ kind: "target", ref: "main", targetOid: "b" });
  });

  it("has nothing to compare on the main branch itself", () => {
    const refs = [ref("main", "branch", "a", true), ref("origin/main", "remote", "b")];
    expect(conflictTarget(refs, "main").kind).toBe("none");
  });

  it("explains a missing main branch and a detached HEAD", () => {
    expect(conflictTarget([ref("topic", "branch", "a", true)], "topic")).toMatchObject({ kind: "none", reason: "No main branch to compare against" });
    expect(conflictTarget([ref("main", "branch", "a")], null).kind).toBe("none");
  });
});
