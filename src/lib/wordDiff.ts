/** Which words changed between two versions of a line. */

export type Range = [number, number];

const PIECE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
const MAX_PIECES = 400;
/** Below this share of unchanged text the line was rewritten, and marking every word is just noise. */
const MIN_SIMILARITY = 0.35;

function pieces(s: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const m of s.matchAll(PIECE)) out.push({ text: m[0], at: m.index ?? 0 });
  return out;
}

/** Longest common subsequence of two piece lists, as the matched index pairs. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const table = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

function toRanges(src: string, list: { text: string; at: number }[], kept: Set<number>): Range[] {
  const ranges: Range[] = [];
  list.forEach((p, idx) => {
    if (kept.has(idx)) return;
    const end = p.at + p.text.length;
    const last = ranges[ranges.length - 1];
    // Only blanks between two changed pieces: they belong to the change.
    if (last && /^\s*$/.test(src.slice(last[1], p.at))) last[1] = end;
    else ranges.push([p.at, end]);
  });
  return ranges;
}

/**
 * The changed parts of `before` and `after`, or null when the lines are too different (or too long)
 * for a word-level view to help.
 */
export function changedRanges(before: string, after: string): { before: Range[]; after: Range[] } | null {
  if (before === after) return { before: [], after: [] };
  const a = pieces(before);
  const b = pieces(after);
  if (a.length > MAX_PIECES || b.length > MAX_PIECES || a.length === 0 || b.length === 0) return null;
  const pairs = lcs(
    a.map((p) => p.text),
    b.map((p) => p.text),
  );
  const keptA = new Set(pairs.map(([i]) => i));
  const keptB = new Set(pairs.map(([, j]) => j));
  const same = pairs.reduce((sum, [i]) => sum + a[i].text.length, 0);
  if (same / Math.max(before.length, after.length, 1) < MIN_SIMILARITY) return null;
  return { before: toRanges(before, a, keptA), after: toRanges(after, b, keptB) };
}
