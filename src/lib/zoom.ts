/** Page zoom, as percentages. The steps are the ones browsers use, so the shortcuts feel familiar. */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;
export const ZOOM_DEFAULT = 100;
export const ZOOM_PREF = "ui.zoom";

/** Clamps whatever was stored to a supported percentage (a hand-edited or old value must not break the window). */
export function sanitizeZoom(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : ZOOM_DEFAULT;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], n));
}

/** The next step up or down from the current zoom (which may sit between two steps). */
export function stepZoom(current: number, direction: 1 | -1): number {
  const now = sanitizeZoom(current);
  if (direction > 0) return ZOOM_STEPS.find((s) => s > now) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < now) ?? ZOOM_STEPS[0];
}
