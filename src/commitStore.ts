import type { CommitRow } from "./ipc";

/**
 * Mutable row storage kept outside React state: history can reach hundreds of
 * thousands of rows and arrives in chunks, so React only tracks `count`.
 */
export class CommitStore {
  rows: CommitRow[] = [];
  /** oid → row index, for jumping from refs and parents to rows. */
  index = new Map<string, number>();
  /** Widest lane count seen so far; sizes the graph column. */
  maxLanes = 1;

  get length() {
    return this.rows.length;
  }

  clear() {
    this.rows = [];
    this.index.clear();
    this.maxLanes = 1;
  }

  push(chunk: CommitRow[]) {
    for (const row of chunk) {
      this.index.set(row.oid, this.rows.length);
      this.rows.push(row);
      const g = row.graph;
      let widest = g.lane + 1;
      for (const [lane] of g.incoming) widest = Math.max(widest, lane + 1);
      for (const [lane] of g.through) widest = Math.max(widest, lane + 1);
      for (const [lane] of g.outgoing) widest = Math.max(widest, lane + 1);
      if (widest > this.maxLanes) this.maxLanes = widest;
    }
  }
}
