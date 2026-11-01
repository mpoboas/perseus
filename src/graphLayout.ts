/** Geometry shared by the canvas renderer and the pointer handling around it. */

export const ROW_H = 26;
export const DRAG_THRESHOLD_PX = 5;

/** A ref badge as painted on a row (x is relative to the canvas, w is its width). */
export interface Badge {
  ref: string;
  x: number;
  w: number;
}

/** What the pointer is over: a ref badge, or a commit row. */
export type Subject = { kind: "ref"; name: string; row: number } | { kind: "commit"; row: number };

/** The row under canvas-relative `y`, or null past the last row. */
export function rowAt(y: number, scrollTop: number, count: number): number | null {
  if (y < 0) return null;
  const row = Math.floor((y + scrollTop) / ROW_H);
  return row >= 0 && row < count ? row : null;
}

export function badgeAt(badges: readonly Badge[] | undefined, x: number): Badge | null {
  return badges?.find((b) => x >= b.x && x <= b.x + b.w) ?? null;
}

/** Resolves the thing under the pointer, preferring a badge over its row. */
export function subjectAt(
  x: number,
  y: number,
  scrollTop: number,
  count: number,
  badgesByRow: ReadonlyMap<number, readonly Badge[]>,
): Subject | null {
  const row = rowAt(y, scrollTop, count);
  if (row === null) return null;
  const badge = badgeAt(badgesByRow.get(row), x);
  return badge ? { kind: "ref", name: badge.ref, row } : { kind: "commit", row };
}

/** True once the pointer has moved far enough that a press becomes a drag, not a click. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

export function sameSubject(a: Subject | null, b: Subject | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.row !== b.row) return false;
  return a.kind === "ref" && b.kind === "ref" ? a.name === b.name : true;
}
