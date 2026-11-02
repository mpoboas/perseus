import { describe, expect, it } from "vitest";
import { parseDiff } from "./diffParse";
import { renderRows, splitRows } from "./diffRender";
import { START, applyRanges, languageFor, tokenize } from "./highlight";
import { changedRanges } from "./wordDiff";

const kinds = (lang: string, line: string) => tokenize(lang, line).tokens.map((t) => `${t.kind}:${t.text}`);

describe("languageFor", () => {
  it("picks a grammar from the file name", () => {
    expect(languageFor("src/App.tsx")).toBe("js");
    expect(languageFor("a/b/main.rs")).toBe("rust");
    expect(languageFor("Cargo.lock")).toBe("kv");
    expect(languageFor("Dockerfile")).toBe("shell");
    expect(languageFor("photo.png")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
  });
});

describe("tokenize", () => {
  it("colours keywords, strings, numbers, calls and comments", () => {
    expect(kinds("js", 'const x = foo("a", 12); // done')).toEqual([
      "kw:const",
      "plain: x = ",
      "fn:foo",
      "plain:(",
      'str:"a"',
      "plain:, ",
      "num:12",
      "plain:); ",
      "com:// done",
    ]);
  });

  it("carries an open block comment onto the next line", () => {
    const a = tokenize("c", "int x; /* start", START);
    expect(a.state.block).toBe(true);
    const b = tokenize("c", "still comment */ int y;", a.state);
    expect(b.tokens[0]).toEqual({ text: "still comment */", kind: "com" });
    expect(b.state.block).toBe(false);
    expect(b.tokens.some((t) => t.kind === "kw" && t.text === "int")).toBe(true);
  });

  it("handles python triple quotes across lines", () => {
    const a = tokenize("python", 'doc = """first', START);
    expect(a.state.triple).toBe('"""');
    const b = tokenize("python", 'second""" + x', a.state);
    expect(b.tokens[0].kind).toBe("str");
    expect(b.state.triple).toBeNull();
  });

  it("tells a Rust lifetime from a character", () => {
    expect(kinds("rust", "fn f<'a>(c: &'a str) -> char { 'x' }")).toContain("typ:'a");
    expect(kinds("rust", "let c = 'x';")).toContain("str:'x'");
  });

  it("marks JSON keys, config keys and markup tags", () => {
    expect(kinds("json", '  "name": "perseus",')).toContain("prop:\"name\"");
    expect(kinds("kv", "version = 1")[0]).toBe("prop:version");
    expect(kinds("kv", "  - name: build")).toContain("prop:name");
    expect(kinds("markup", '<div class="a">')).toEqual(["tag:<div", "plain: ", "attr:class", "plain:=", 'str:"a"', "tag:>"]);
  });

  it("leaves unknown languages and odd input alone", () => {
    expect(tokenize("nope", "whatever", START).tokens).toEqual([{ text: "whatever", kind: "plain" }]);
    expect(tokenize("js", "", START).tokens).toEqual([]);
    expect(tokenize("js", "'unterminated", START).tokens[0].kind).toBe("str");
  });

  it("never loses or invents characters", () => {
    const line = 'let s = "a\\"b" + 0x1F + `t`; /* c */ // d ☃';
    expect(tokenize("js", line).tokens.map((t) => t.text).join("")).toBe(line);
  });
});

describe("changedRanges", () => {
  it("marks only the words that differ", () => {
    const r = changedRanges("let total = price * 3;", "let total = price * 4;")!;
    expect(r.before).toEqual([[20, 21]]);
    expect(r.after).toEqual([[20, 21]]);
  });

  it("joins neighbouring changed words with the blank between them", () => {
    const r = changedRanges("call(alpha beta gamma)", "call(delta epsilon gamma)")!;
    expect(r.before).toEqual([[5, 15]]);
    expect(r.after).toEqual([[5, 18]]);
  });

  it("gives up on lines that were rewritten", () => {
    expect(changedRanges("completely one thing", "xyz 123 ??")).toBeNull();
  });

  it("has nothing to mark in identical lines", () => {
    expect(changedRanges("same", "same")).toEqual({ before: [], after: [] });
  });
});

describe("applyRanges", () => {
  it("splits tokens at the edges of a changed range", () => {
    const tokens = tokenize("js", "const abc = 1;").tokens;
    const segs = applyRanges(tokens, [[6, 9]]);
    expect(segs.filter((s) => s.changed).map((s) => s.text)).toEqual(["abc"]);
    expect(segs.map((s) => s.text).join("")).toBe("const abc = 1;");
  });
});

const PATCH = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,5 +1,5 @@
 import x from "x";
-const price = 3;
-const name = "a";
+const price = 4;
+const name = "b";
+const extra = 1;
 export {};
-gone();
+back();
`;

describe("renderRows and splitRows", () => {
  const rows = parseDiff(PATCH).rows.filter((r) => r.kind !== "meta" || r.text.startsWith("\\"));

  it("colours rows and pairs the changed words of -/+ lines in order", () => {
    const out = renderRows(rows, "js", true);
    const del = rows.findIndex((r) => r.kind === "del");
    expect(out[del].tokens[0]).toEqual({ text: "const", kind: "kw" });
    expect(out[del].ranges).toEqual([[14, 15]]);
    expect(out[del + 2].ranges).toEqual([[14, 15]]);
    // The third added line has no removed partner.
    expect(out[del + 4].ranges).toBeUndefined();
  });

  it("can skip word marks and colours", () => {
    const out = renderRows(rows, null, false);
    expect(out.every((r) => r.ranges === undefined && r.tokens.every((t) => t.kind === "plain"))).toBe(true);
  });

  it("lines removed and added lines up side by side", () => {
    const split = splitRows(rows);
    const pairs = split.filter((s) => s.kind === "pair");
    const text = (i: number | null) => (i === null ? "" : rows[i].text);
    const shown = pairs.map((p) => (p.kind === "pair" ? `${text(p.left)} | ${text(p.right)}` : ""));
    expect(shown).toEqual([
      'import x from "x"; | import x from "x";',
      "const price = 3; | const price = 4;",
      'const name = "a"; | const name = "b";',
      " | const extra = 1;",
      "export {}; | export {};",
      "gone(); | back();",
    ]);
    expect(split[0].kind).toBe("full");
  });
});
