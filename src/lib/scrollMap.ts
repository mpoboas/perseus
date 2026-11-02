/**
 * Browsers cap how tall a scrollable area can be (about 33 million pixels in Chromium, less elsewhere),
 * and a commit list of a million rows at 28 px each is taller than that: the last rows could never be
 * scrolled to. Past a cap the graph stretches the scroll bar instead: one pixel of the real scroll
 * position stands for `scale` pixels of the list.
 */

/** The tallest scroll area the graph asks the browser for. Well below every engine's limit. */
export const MAX_SCROLL_PX = 8_000_000;

export interface ScrollMap {
  /** The height to give the scroll area's spacer (the real, physical scroll range). */
  range: number;
  /** List pixels per real scroll pixel: 1 until the list outgrows the cap. */
  scale: number;
}

/** How a list of `rows` rows of `rowH` pixels, shown through a window `viewH` tall, maps onto the scroll area. */
export function scrollMap(rows: number, rowH: number, viewH: number, cap = MAX_SCROLL_PX): ScrollMap {
  const listRange = Math.max(0, rows * rowH - viewH);
  const range = Math.min(listRange, cap);
  return { range, scale: range > 0 ? listRange / range : 1 };
}

/** The position in the list (in list pixels) that a real scroll position stands for. */
export const toList = (scrollTop: number, scale: number) => scrollTop * scale;

/** The real scroll position that shows a position of the list. */
export const toScroll = (listTop: number, scale: number) => listTop / scale;
