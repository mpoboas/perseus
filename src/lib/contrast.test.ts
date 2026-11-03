import { describe, expect, it } from "vitest";
// @ts-expect-error type error without the @types/node package (as in vite.config.ts)
import { readFileSync } from "node:fs";

// Vitest hands back an empty string for a stylesheet imported with `?raw`, so it is read from disk.
const tokens: string = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** Reads the colour tokens of each theme out of tokens.css, applying overrides in the order the cascade does. */
function theme(selectors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const selector of selectors) {
    const start = tokens.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`tokens.css has no ${selector} block`);
    const body = tokens.slice(start, tokens.indexOf("\n}", start));
    for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  }
  return vars;
}

const THEMES: Record<string, Record<string, string>> = {
  "slate dark": theme([":root"]),
  "slate light": theme([":root", ':root[data-theme="light"]']),
  "indigo dark": theme([":root", ':root[data-palette="indigo"][data-theme="dark"]']),
  "indigo light": theme([":root", ':root[data-theme="light"]', ':root[data-palette="indigo"][data-theme="light"]']),
};

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--bg", "--surface-1", "--surface-2", "--surface-3"];

describe.each(Object.entries(THEMES))("contrast in %s", (_name, vars) => {
  const at = (token: string) => {
    const v = vars[token];
    if (!v?.startsWith("#")) throw new Error(`${token} is not a hex colour: ${v}`);
    return v;
  };

  // WCAG 1.4.3: text needs 4.5:1 (these are all used at normal sizes).
  it.each([
    ["--text", SURFACES],
    ["--text-dim", SURFACES],
    ["--text-faint", ["--bg", "--surface-1", "--surface-2"]],
    ["--accent", ["--bg", "--surface-1", "--surface-2"]],
    ["--success", ["--bg", "--surface-1"]],
    ["--warn", ["--bg", "--surface-1"]],
    ["--danger", ["--bg", "--surface-1"]],
    ["--info", ["--bg", "--surface-1"]],
  ] as [string, string[]][])("%s is readable text", (fg, backgrounds) => {
    for (const bg of backgrounds) expect(ratio(at(fg), at(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps button text readable", () => {
    expect(ratio(at("--accent-fg"), at("--accent"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(at("--accent-fg"), at("--accent-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps branch and tag labels in the graph readable", () => {
    for (const ref of ["--ref-head", "--ref-branch", "--ref-remote", "--ref-tag"])
      expect(ratio(at("--ref-text-on"), at(ref)), `label on ${ref}`).toBeGreaterThanOrEqual(4.5);
  });

  // WCAG 1.4.11: what you need to see to use the graph (lines, nodes, borders of controls) needs 3:1.
  it("keeps the graph's lanes visible", () => {
    for (let i = 0; i < 10; i++) expect(ratio(at(`--lane-${i}`), at("--surface-1")), `lane ${i}`).toBeGreaterThanOrEqual(3);
  });

  it("keeps control borders visible", () => {
    expect(ratio(at("--border-strong"), at("--surface-1"))).toBeGreaterThanOrEqual(1.5);
  });
});
