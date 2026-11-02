/**
 * Geometry shared by the canvas renderer and the pointer handling around it.
 *
 * Rows are *display* rows. When the working tree has changes a "WIP" row is drawn above the
 * first commit; `offset` (0 or 1) is how many such rows precede the commits.
 */

export const ROW_H = 28;
export const DRAG_THRESHOLD_PX = 5;

/** A ref chip as painted on a row (x is relative to the canvas, w is its width). */
export interface Badge {
  ref: string;
  x: number;
  w: number;
}

/** What the pointer is over: a ref chip, a commit row, or the working-tree row. */
export type Subject =
  | { kind: "ref"; name: string; row: number }
  | { kind: "commit"; row: number }
  | { kind: "wip" };

/** The display row under canvas-relative `y`, or null past the last row. */
export function rowAt(y: number, scrollTop: number, count: number): number | null {
  if (y < 0) return null;
  const row = Math.floor((y + scrollTop) / ROW_H);
  return row >= 0 && row < count ? row : null;
}

export function badgeAt(badges: readonly Badge[] | undefined, x: number): Badge | null {
  return badges?.find((b) => x >= b.x && x <= b.x + b.w) ?? null;
}

/**
 * Resolves the thing under the pointer, preferring a chip over its row. `badgesByRow` is keyed
 * by commit row, and `count` is the number of commits (not display rows).
 */
export function subjectAt(
  x: number,
  y: number,
  scrollTop: number,
  count: number,
  badgesByRow: ReadonlyMap<number, readonly Badge[]>,
  offset = 0,
): Subject | null {
  const display = rowAt(y, scrollTop, count + offset);
  if (display === null) return null;
  if (display < offset) return { kind: "wip" };
  const row = display - offset;
  const badge = badgeAt(badgesByRow.get(row), x);
  return badge ? { kind: "ref", name: badge.ref, row } : { kind: "commit", row };
}

/** True once the pointer has moved far enough that a press becomes a drag, not a click. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

export function sameSubject(a: Subject | null, b: Subject | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "wip" || b.kind === "wip") return true;
  if (a.row !== b.row) return false;
  return a.kind === "ref" && b.kind === "ref" ? a.name === b.name : true;
}
