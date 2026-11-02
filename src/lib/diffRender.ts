import type { DiffRow } from "./diffParse";
import { START, type State, type Token, tokenize } from "./highlight";
import { type Range, changedRanges } from "./wordDiff";

/** What the diff view draws for one row: its coloured pieces, and which parts of it changed. */
export interface Rendered {
  tokens: Token[];
  ranges?: Range[];
}

/** Very long lines are shown plain: they are usually minified or generated. */
const MAX_LINE = 2000;

const same = (a: State, b: State) => a.block === b.block && a.triple === b.triple;

/** Colours every row (`lang` null means none) and, when asked, marks the changed words of paired -/+ lines. */
export function renderRows(rows: DiffRow[], lang: string | null, words: boolean): Rendered[] {
  const out: Rendered[] = new Array(rows.length);
  let oldState = START;
  let newState = START;

  rows.forEach((r, i) => {
    if (r.kind === "hunk") {
      oldState = START;
      newState = START;
    }
    const plain: Token[] = [{ text: r.text, kind: "plain" }];
    if (!lang || r.kind === "meta" || r.kind === "hunk" || r.text.length > MAX_LINE) {
      out[i] = { tokens: plain };
      return;
    }
    if (r.kind === "add") {
      const t = tokenize(lang, r.text, newState);
      newState = t.state;
      out[i] = { tokens: t.tokens };
    } else if (r.kind === "del") {
      const t = tokenize(lang, r.text, oldState);
      oldState = t.state;
      out[i] = { tokens: t.tokens };
    } else {
      const t = tokenize(lang, r.text, newState);
      out[i] = { tokens: t.tokens };
      oldState = same(oldState, newState) ? t.state : tokenize(lang, r.text, oldState).state;
      newState = t.state;
    }
  });

  if (words) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind !== "del") continue;
      let dels = i;
      while (dels < rows.length && rows[dels].kind === "del") dels++;
      let adds = dels;
      while (adds < rows.length && rows[adds].kind === "add") adds++;
      const pairs = Math.min(dels - i, adds - dels);
      for (let k = 0; k < pairs; k++) {
        const del = i + k;
        const add = dels + k;
        if (rows[del].text.length > MAX_LINE || rows[add].text.length > MAX_LINE) continue;
        const diff = changedRanges(rows[del].text, rows[add].text);
        if (diff) {
          out[del].ranges = diff.before;
          out[add].ranges = diff.after;
        }
      }
      i = adds - 1;
    }
  }
  return out;
}

/** A line of the split view: a banner spanning both sides, or an old line beside a new one. */
export type SplitRow =
  | { kind: "full"; at: number }
  | { kind: "pair"; left: number | null; right: number | null };

/** Lays unified rows out in two columns: removed lines on the left beside the added lines that replace them. */
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === "del" || r.kind === "add") {
      let dels = i;
      while (dels < rows.length && rows[dels].kind === "del") dels++;
      let adds = dels;
      while (adds < rows.length && rows[adds].kind === "add") adds++;
      const count = Math.max(dels - i, adds - dels);
      for (let k = 0; k < count; k++) {
        out.push({ kind: "pair", left: k < dels - i ? i + k : null, right: k < adds - dels ? dels + k : null });
      }
      i = adds - 1;
    } else if (r.kind === "ctx") {
      out.push({ kind: "pair", left: i, right: i });
    } else {
      out.push({ kind: "full", at: i });
    }
  }
  return out;
}
