import { describe, expect, it } from "vitest";
import { hunkChecksum, parseDiff } from "./diffParse";
import { buildFileTree } from "./fileTree";
import { fuzzyMatch } from "./fuzzy";
import { folderFromUrl, hueOf, initials, relativeTime, splitPath } from "./format";
import { buildRefTree } from "./refTree";
import { arrived, newTally, waitForRows } from "./streamWait";

describe("format", () => {
  it("makes initials from names, emails and single words", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("grace")).toBe("G");
    expect(initials("Jean-Luc Picard <jl@x.org>")).toBe("JP");
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("names the folder of a clone after its address", () => {
    expect(folderFromUrl("https://github.com/owner/lib.git")).toBe("lib");
    expect(folderFromUrl("git@github.com:owner/other-lib.git")).toBe("other-lib");
    expect(folderFromUrl("C:\\Users\\me\\projects\\tool\\")).toBe("tool");
    expect(folderFromUrl("/home/me/src/thing")).toBe("thing");
    expect(folderFromUrl("")).toBe("");
  });

  it("gives the same person the same hue", () => {
    expect(hueOf("ada")).toBe(hueOf("ada"));
    expect(hueOf("ada")).not.toBe(hueOf("grace"));
    expect(hueOf("x")).toBeGreaterThanOrEqual(0);
    expect(hueOf("x")).toBeLessThan(360);
  });

  it("describes elapsed time in the coarsest sensible unit", () => {
    const now = 1_000_000_000_000;
    const ago = (s: number) => now / 1000 - s;
    expect(relativeTime(ago(5), now)).toBe("just now");
    expect(relativeTime(ago(120), now)).toBe("2m ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3h ago");
    expect(relativeTime(ago(5 * 86400), now)).toBe("5d ago");
    expect(relativeTime(ago(90 * 86400), now)).toBe("3mo ago");
  });

  it("splits paths into folder and name", () => {
    expect(splitPath("a/b/c.ts")).toEqual({ dir: "a/b/", name: "c.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("fuzzyMatch", () => {
  it("matches subsequences and rejects the rest", () => {
    expect(fuzzyMatch("fmn", "feature/main")).not.toBeNull();
    expect(fuzzyMatch("xyz", "feature/main")).toBeNull();
    expect(fuzzyMatch("", "anything")?.score).toBe(0);
  });

  it("ranks exact and word-start matches above scattered ones", () => {
    const exact = fuzzyMatch("push", "Push to origin")!;
    const scattered = fuzzyMatch("push", "Pull, then use shell")!;
    expect(exact.score).toBeGreaterThan(scattered.score);
    const early = fuzzyMatch("main", "main")!;
    const late = fuzzyMatch("main", "feature/domain-main-thing")!;
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("reports the matched positions", () => {
    expect(fuzzyMatch("ab", "xxabxx")?.positions).toEqual([2, 3]);
    expect(fuzzyMatch("ac", "abc")?.positions).toEqual([0, 2]);
  });
});

describe("buildRefTree", () => {
  it("nests slash-separated names, folders first", () => {
    const tree = buildRefTree([
      { name: "main" },
      { name: "feature/ui/palette" },
      { name: "feature/ui/graph" },
      { name: "feature/api" },
      { name: "zeta" },
    ]);
    expect(tree.map((n) => `${n.type}:${n.label}`)).toEqual(["folder:feature", "leaf:main", "leaf:zeta"]);
    const feature = tree[0];
    if (feature.type !== "folder") throw new Error("expected folder");
    expect(feature.count).toBe(3);
    expect(feature.children.map((n) => n.label)).toEqual(["ui", "api"]);
    const ui = feature.children[0];
    if (ui.type !== "folder") throw new Error("expected folder");
    expect(ui.children.map((n) => (n.type === "leaf" ? n.name : ""))).toEqual([
      "feature/ui/graph",
      "feature/ui/palette",
    ]);
  });
});

describe("buildFileTree", () => {
  it("merges single-child folder chains and keeps folders first", () => {
    const tree = buildFileTree([
      { path: "src/ui/a.tsx" },
      { path: "src/ui/b.tsx" },
      { path: "README.md" },
      { path: "deep/er/est/x.rs" },
    ]);
    expect(tree.map((n) => (n.type === "dir" ? `dir:${n.name}` : `file:${n.name}`))).toEqual([
      "dir:deep/er/est",
      "dir:src/ui",
      "file:README.md",
    ]);
  });
});

describe("parseDiff", () => {
  const patch = [
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,4 @@ fn",
    " one",
    "-two",
    "+TWO",
    "+extra",
    " three",
    "\\ No newline at end of file",
    "@@ -10 +11 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  it("numbers lines on both sides and counts changes", () => {
    const d = parseDiff(patch);
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(2);
    const body = d.rows.filter((r) => r.kind !== "meta");
    expect(body.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ["hunk", null, null],
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
      ["hunk", null, null],
      ["del", 10, null],
      ["add", null, 11],
    ]);
  });

  it("treats header lines before the first hunk as meta, even if they start with +/-", () => {
    const d = parseDiff(patch);
    expect(d.rows.slice(0, 4).every((r) => r.kind === "meta")).toBe(true);
    expect(d.rows[2].text).toBe("--- a/f.txt");
  });

  it("flags binary patches and handles empty input", () => {
    expect(parseDiff("Binary files a/x and b/x differ\n").binary).toBe(true);
    const empty = parseDiff("");
    expect(empty.rows).toHaveLength(0);
    expect(empty.additions + empty.deletions).toBe(0);
  });
});

describe("hunk addressing for staging", () => {
  it("computes the same checksum as the Rust backend (FNV-1a over lines joined by newlines)", () => {
    // 686081808 is FNV-1a of the three bytes a, newline, b, computed independently.
    expect(hunkChecksum(["a", "b"])).toBe(686081808);
    expect(hunkChecksum([])).toBe(0x811c9dc5);
    // Multi-byte characters hash their UTF-8 bytes, as the backend does.
    expect(hunkChecksum(["é"])).not.toBe(hunkChecksum(["e"]));
  });

  it("numbers hunks and the lines inside them, counting no-newline markers", () => {
    const marker = `${String.fromCharCode(92)} No newline at end of file`;
    const lines = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", marker, "@@ -9 +9 @@", "-x", "+y", ""];
    const d = parseDiff(lines.join(String.fromCharCode(10)));
    expect(d.hunks.map((h) => h.header)).toEqual(["@@ -1,2 +1,2 @@", "@@ -9 +9 @@"]);
    const body = d.rows.filter((r) => r.hunk !== undefined && r.kind !== "hunk");
    expect(body.map((r) => [r.hunk, r.idx, r.kind])).toEqual([
      [0, 0, "ctx"],
      [0, 1, "del"],
      [0, 2, "add"],
      [0, 3, "meta"],
      [1, 0, "del"],
      [1, 1, "add"],
    ]);
    expect(d.hunks[0].checksum).toBe(hunkChecksum([" keep", "-old", "+new", marker]));
    expect(d.hunks[1].checksum).toBe(hunkChecksum(["-x", "+y"]));
  });
});

describe("streamWait", () => {
  it("resolves at once when every row has already arrived", async () => {
    const t = newTally();
    arrived(t, 106);
    await expect(waitForRows(t, 106)).resolves.toBeUndefined();
  });

  it("waits for a chunk that arrives after the result", async () => {
    const t = newTally();
    let settled = false;
    const wait = waitForRows(t, 106).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    arrived(t, 100);
    await Promise.resolve();
    expect(settled).toBe(false);
    arrived(t, 6);
    await wait;
    expect(settled).toBe(true);
  });

  it("gives up after the timeout instead of hanging", async () => {
    const t = newTally();
    await expect(waitForRows(t, 5, 20)).resolves.toBeUndefined();
  });
});
