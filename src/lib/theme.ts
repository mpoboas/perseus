import { useEffect, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** The colour set: each has a dark and a light variant, chosen by the theme preference. */
export type Palette = "slate" | "indigo";
export const PALETTES: { id: Palette; label: string }[] = [
  { id: "slate", label: "Slate" },
  { id: "indigo", label: "Indigo" },
];

const KEY = "perseus.theme";
const PALETTE_KEY = "perseus.palette";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? (media().matches ? "dark" : "light") : pref;
}

export function getPalette(): Palette {
  try {
    return localStorage.getItem(PALETTE_KEY) === "indigo" ? "indigo" : "slate";
  } catch {
    return "slate";
  }
}

const listeners = new Set<() => void>();
let current = getThemePref();
let currentPalette = getPalette();

/** Writes the palette to <html> (`data-palette`), like the theme, and has the canvas redraw. */
export function applyPalette(palette: Palette) {
  currentPalette = palette;
  try {
    if (palette === "slate") localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.palette = palette;
  window.dispatchEvent(new Event("perseus-theme"));
  listeners.forEach((l) => l());
}

export function usePalette(): [Palette, (p: Palette) => void] {
  const palette = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => currentPalette,
  );
  return [palette, applyPalette];
}

/** Writes the theme to <html> and tells the canvas (which paints its own colors) to redraw. */
export function applyTheme(pref: ThemePref) {
  current = pref;
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = resolveTheme(pref);
  window.dispatchEvent(new Event("perseus-theme"));
  listeners.forEach((l) => l());
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  // Follow the operating system while the preference is "system".
  useEffect(() => {
    if (pref !== "system") return;
    const m = media();
    const on = () => applyTheme("system");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [pref]);
  return [pref, applyTheme];
}

export const nextTheme = (p: ThemePref): ThemePref =>
  p === "system" ? "light" : p === "light" ? "dark" : "system";
