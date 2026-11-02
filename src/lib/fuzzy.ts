/**
 * Subsequence fuzzy matching for the command palette and the sidebar filter.
 * Higher is better; `null` means "does not match". Rewards matches at word starts,
 * consecutive runs and early positions.
 */
export interface FuzzyMatch {
  score: number;
  /** Indices into the text of the matched characters, for highlighting. */
  positions: number[];
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  return /[\s/_.\-:]/.test(prev) || (prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase());
};

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();

  // An exact substring beats any scattered match.
  const at = t.indexOf(q);
  if (at >= 0) {
    const positions = Array.from({ length: q.length }, (_, i) => at + i);
    return {
      score: 1000 - at + (isBoundary(text, at) ? 60 : 0) - (text.length - q.length) * 0.1,
      positions,
    };
  }

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const consecutive = positions.length > 0 && i === positions[positions.length - 1] + 1;
    run = consecutive ? run + 1 : 0;
    score += 10 + run * 8 + (isBoundary(text, i) ? 14 : 0) - Math.min(i - from, 12);
    positions.push(i);
    from = i + 1;
  }
  return { score: score - text.length * 0.05, positions };
}
