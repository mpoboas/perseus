/** Parses a unified patch into rows with old/new line numbers for the diff viewer's gutters. */

export type DiffRowKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffRow {
  kind: DiffRowKind;
  /** The line without its leading +/-/space marker (headers keep their text). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Index of the hunk this row belongs to (the hunk header row itself included). */
  hunk?: number;
  /** Index of the row within its hunk's lines (hunk header excluded); what staging refers to. */
  idx?: number;
}

export interface DiffHunk {
  /** The `@@ … @@` line as printed. */
  header: string;
  /** Checksum of the hunk's lines; the backend recomputes it to detect a stale view. */
  checksum: number;
}

export interface ParsedDiff {
  rows: DiffRow[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
  /** Longest line, in characters; sizes the horizontal scroll extent. */
  widest: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const encoder = new TextEncoder();

/** FNV-1a over the lines joined by "\n"; identical to `hunk_checksum` in the Rust backend. */
export function hunkChecksum(lines: readonly string[]): number {
  let hash = 0x811c9dc5;
  const bytes = encoder.encode(lines.join("\n"));
  for (const b of bytes) {
    hash = Math.imul(hash ^ b, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function parseDiff(patch: string): ParsedDiff {
  const lines = patch.replace(/\n$/, "").split("\n");
  const rows: DiffRow[] = [];
  const hunks: DiffHunk[] = [];
  let hunkLines: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let widest = 0;

  const closeHunk = () => {
    if (inHunk && hunks.length > 0) hunks[hunks.length - 1].checksum = hunkChecksum(hunkLines);
    hunkLines = [];
  };
  const hunkIdx = () => hunks.length - 1;

  for (const line of lines) {
    if (line === "" && rows.length === 0) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      closeHunk();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      hunks.push({ header: line, checksum: 0 });
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null, hunk: hunkIdx() });
    } else if (line.startsWith("diff ")) {
      // A new file header always ends the previous hunk (multi-file patches).
      closeHunk();
      inHunk = false;
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (!inHunk) {
      if (line.startsWith("Binary ") || line.startsWith("GIT binary patch")) binary = true;
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      const idx = hunkLines.length;
      hunkLines.push(line);
      const at = { hunk: hunkIdx(), idx };
      if (line.startsWith("+")) {
        additions++;
        rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++, ...at });
      } else if (line.startsWith("-")) {
        deletions++;
        rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null, ...at });
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
        rows.push({ kind: "meta", text: line, oldNo: null, newNo: null, ...at });
      } else {
        rows.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++, ...at });
      }
    }
    widest = Math.max(widest, rows[rows.length - 1].text.length);
  }
  closeHunk();
  return { rows, hunks, additions, deletions, binary, widest };
}
