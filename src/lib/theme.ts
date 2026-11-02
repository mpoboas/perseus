import { useEffect, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "perseus.theme";
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

const listeners = new Set<() => void>();
let current = getThemePref();

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
