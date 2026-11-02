/** Parses a unified patch into rows with old/new line numbers for the diff viewer's gutters. */

export type DiffRowKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffRow {
  kind: DiffRowKind;
  /** The line without its leading +/-/space marker (headers keep their text). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface ParsedDiff {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  binary: boolean;
  /** Longest line, in characters; sizes the horizontal scroll extent. */
  widest: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(patch: string): ParsedDiff {
  const lines = patch.replace(/\n$/, "").split("\n");
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let widest = 0;

  for (const line of lines) {
    if (line === "" && rows.length === 0) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith("diff ")) {
      // A new file header always ends the previous hunk (multi-file patches).
      inHunk = false;
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (!inHunk) {
      if (line.startsWith("Binary ") || line.startsWith("GIT binary patch")) binary = true;
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith("+")) {
      additions++;
      rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith("-")) {
      deletions++;
      rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      rows.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    widest = Math.max(widest, rows[rows.length - 1].text.length);
  }
  return { rows, additions, deletions, binary, widest };
}
