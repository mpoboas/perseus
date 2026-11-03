import { useMemo } from "react";
import { usePref } from "./prefs";

/**
 * Keyboard shortcuts as data, so the handler, the cheat sheet, the tooltips and the settings page all
 * read one list. A binding is a string such as `Mod+Shift+Z`, `F5` or `?`:
 *
 * - `Mod` is the main modifier: Command on macOS, Control elsewhere.
 * - `Ctrl`, `Alt` and `Shift` are what they say; `Meta` is the Windows/Command key where `Mod` is Control.
 * - the key comes last (`Plus` stands for `+`, `Space` for the space bar), compared case-insensitively.
 */

export type ShortcutId =
  | "palette"
  | "open"
  | "search"
  | "undo"
  | "redo"
  | "sidebar"
  | "refresh"
  | "settings"
  | "help"
  | "commit"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export type ShortcutGroup = "General" | "View" | "Changes";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  /** Bindings used until the user picks their own. The first one is the one shown in menus and tooltips. */
  defaults: string[];
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", group: "General", defaults: ["Mod+K", "Mod+P"] },
  { id: "open", label: "Open repository", group: "General", defaults: ["Mod+O"] },
  { id: "search", label: "Search commits", group: "General", defaults: ["Mod+F"] },
  { id: "undo", label: "Undo the last action", group: "General", defaults: ["Mod+Z"] },
  { id: "redo", label: "Redo", group: "General", defaults: ["Mod+Shift+Z", "Mod+Y"] },
  { id: "refresh", label: "Refresh", group: "General", defaults: ["F5", "Mod+R"] },
  { id: "settings", label: "Settings", group: "General", defaults: ["Mod+,"] },
  { id: "help", label: "Keyboard shortcuts", group: "General", defaults: ["?"] },
  { id: "sidebar", label: "Show or hide the sidebar", group: "View", defaults: ["Mod+B"] },
  { id: "zoomIn", label: "Zoom in", group: "View", defaults: ["Mod+=", "Mod+Plus"] },
  { id: "zoomOut", label: "Zoom out", group: "View", defaults: ["Mod+-"] },
  { id: "zoomReset", label: "Actual size", group: "View", defaults: ["Mod+0"] },
  { id: "commit", label: "Commit (in the message box)", group: "Changes", defaults: ["Mod+Enter"] },
];

/** Shortcuts that are not rebindable, listed in the cheat sheet so it stays complete. */
export const FIXED_SHORTCUTS: { group: string; label: string; keys: string }[] = [
  { group: "Graph", label: "Move between commits", keys: "↑ / ↓" },
  { group: "Graph", label: "Page up / down", keys: "PgUp / PgDn" },
  { group: "Graph", label: "First / last commit", keys: "Home / End" },
  { group: "Graph", label: "Context menu", keys: "Shift+F10" },
  { group: "Graph", label: "Merge, rebase, cherry-pick", keys: "Drag onto a branch" },
  { group: "Changes", label: "Close diff", keys: "Esc" },
];

export type Overrides = Partial<Record<ShortcutId, string[]>>;

const PREF = "shortcuts";

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

// ---------------------------------------------------------------- parsing

export interface Parsed {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const MODIFIERS = new Set(["mod", "ctrl", "control", "alt", "option", "shift", "meta", "cmd", "command", "win"]);

/** The key as written in bindings: lower case, `+` → `plus`, space → `space`. */
export function normalizeKey(key: string): string {
  if (key === "+") return "plus";
  if (key === " ") return "space";
  return key.toLowerCase();
}

export function parseBinding(binding: string): Parsed | null {
  const out: Parsed = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: "" };
  // A literal "+" key would split into two empty tokens; `Plus` is the spelling for it.
  const parts = binding.split("+");
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const part = raw.toLowerCase();
    if (i < parts.length - 1) {
      if (part === "mod") out.mod = true;
      else if (part === "ctrl" || part === "control") out.ctrl = true;
      else if (part === "alt" || part === "option") out.alt = true;
      else if (part === "shift") out.shift = true;
      else if (part === "meta" || part === "cmd" || part === "command" || part === "win") out.meta = true;
      else return null;
    } else {
      if (raw === "") return null;
      out.key = part;
    }
  }
  return out.key && !MODIFIERS.has(out.key) ? out : null;
}

/** `?`, `=`, `,` and friends: the shifted state depends on the keyboard layout, so Shift is not compared. */
const isSymbol = (key: string) => key === "plus" || (key.length === 1 && !/[a-z0-9]/.test(key));

/** The key of an event, as a binding spells it. Option on a Mac changes `e.key` (⌥K types "˚"), so letters come from the key's position. */
export function eventKey(e: Pick<KeyboardEvent, "key" | "code" | "altKey">): string {
  if (e.altKey) {
    const letter = /^Key([A-Z])$/.exec(e.code ?? "");
    if (letter) return letter[1].toLowerCase();
    const digit = /^Digit(\d)$/.exec(e.code ?? "");
    if (digit) return digit[1];
  }
  return normalizeKey(e.key);
}

export type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

export function matches(e: KeyEventLike, binding: string, mac = isMac()): boolean {
  const p = parseBinding(binding);
  if (!p) return false;
  if (eventKey(e) !== p.key) return false;
  const wantCtrl = p.ctrl || (p.mod && !mac);
  const wantMeta = p.meta || (p.mod && mac);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== p.alt) return false;
  return isSymbol(p.key) && !p.shift ? true : e.shiftKey === p.shift;
}

/** True when the binding is a bare key that would otherwise be typed into a text box. */
export function isTypingKey(binding: string): boolean {
  const p = parseBinding(binding);
  return !!p && !p.mod && !p.ctrl && !p.alt && !p.meta && p.key.length === 1;
}

/** The binding an event would record: `Mod` for the main modifier, so a recorded shortcut works on both systems' conventions. */
export function bindingFromEvent(e: KeyEventLike, mac = isMac()): string | null {
  const key = eventKey(e);
  if (MODIFIERS.has(key) || ["control", "shift", "alt", "meta", "os", "altgraph"].includes(key)) return null;
  const mainDown = mac ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mainDown) parts.push("Mod");
  if (mac ? e.ctrlKey : e.metaKey) parts.push(mac ? "Ctrl" : "Meta");
  if (e.altKey) parts.push("Alt");
  // For symbols Shift is part of the character itself (`?`), so it is not recorded.
  if (e.shiftKey && !isSymbol(key)) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key === "plus" ? "Plus" : key === "space" ? "Space" : capitalize(key));
  return parts.join("+");
}

const capitalize = (s: string) => (/^f\d+$/.test(s) ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1));

/** Why a recorded binding cannot be used, or null when it is fine. */
export function bindingProblem(binding: string): string | null {
  const p = parseBinding(binding);
  if (!p) return "That is not a key combination.";
  if (p.key === "escape") return "Esc is used to cancel.";
  if (p.key === "tab") return "Tab moves between controls.";
  const modified = p.mod || p.ctrl || p.alt || p.meta;
  if (!modified && !/^f\d+$/.test(p.key) && !isSymbol(p.key)) return "Add Ctrl, Alt or ⌘: a bare letter would be typed into text boxes.";
  return null;
}

// ---------------------------------------------------------------- resolving

export function resolve(overrides: Overrides): Record<ShortcutId, string[]> {
  const out = {} as Record<ShortcutId, string[]>;
  for (const s of SHORTCUTS) {
    const own = overrides[s.id];
    out[s.id] = Array.isArray(own) ? own.filter((b) => parseBinding(b)) : s.defaults;
  }
  return out;
}

/** Another action that already uses this binding, so assigning it would make two things happen at once. */
export function conflictFor(bindings: Record<ShortcutId, string[]>, id: ShortcutId, binding: string): ShortcutId | null {
  const want = canonical(binding);
  for (const s of SHORTCUTS) {
    if (s.id !== id && bindings[s.id].some((b) => canonical(b) === want)) return s.id;
  }
  return null;
}

/** Whether two bindings are the same combination, however each was spelled. */
export const sameBinding = (a: string, b: string) => canonical(a) === canonical(b);

function canonical(binding: string): string {
  const p = parseBinding(binding);
  if (!p) return binding.toLowerCase();
  return [p.mod && "mod", p.ctrl && "ctrl", p.alt && "alt", p.shift && !isSymbol(p.key) && "shift", p.meta && "meta", p.key]
    .filter(Boolean)
    .join("+");
}

/** Which action (if any) a key event triggers. */
export function actionFor(e: KeyEventLike, bindings: Record<ShortcutId, string[]>, typing: boolean, mac = isMac()): ShortcutId | null {
  for (const s of SHORTCUTS) {
    for (const b of bindings[s.id]) {
      if (typing && isTypingKey(b)) continue;
      if (matches(e, b, mac)) return s.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------- display

const MAC_GLYPH: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const WIN_NAME: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };
const KEY_GLYPH: Record<string, string> = {
  plus: "+",
  space: "Space",
  enter: "Enter",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  pageup: "PgUp",
  pagedown: "PgDn",
  backspace: "⌫",
  delete: "Del",
};

/** The key caps to draw for a binding, in this system's own words: `Mod+Shift+Z` is ⌘ ⇧ Z on a Mac and Ctrl Shift Z elsewhere. */
export function displayKeys(binding: string, mac = isMac()): string[] {
  const parts = binding.split("+");
  return parts.map((raw, i) => {
    const part = raw.toLowerCase();
    if (i < parts.length - 1) {
      const name = part === "control" ? "ctrl" : part === "option" ? "alt" : part === "cmd" || part === "command" || part === "win" ? "meta" : part;
      return (mac ? MAC_GLYPH[name] : WIN_NAME[name]) ?? raw;
    }
    return KEY_GLYPH[part] ?? (part.length === 1 || /^f\d+$/.test(part) ? part.toUpperCase() : raw);
  });
}

/** Plain text for tooltips and messages: `⌘Z` on a Mac, `Ctrl+Z` elsewhere. */
export function bindingText(binding: string, mac = isMac()): string {
  const keys = displayKeys(binding, mac);
  return mac ? keys.join("") : keys.join("+");
}

// ---------------------------------------------------------------- reading the preference

/** The bindings in force right now, for code that is not a component (messages written when something happens). */
export function currentBindings(): Record<ShortcutId, string[]> {
  try {
    const raw = localStorage.getItem(`perseus.${PREF}`);
    return resolve(raw ? (JSON.parse(raw) as Overrides) : {});
  } catch {
    return resolve({});
  }
}

export function useShortcutOverrides() {
  return usePref<Overrides>(PREF, {});
}

/** All bindings, re-rendering the caller when the user changes one. */
export function useBindings(): Record<ShortcutId, string[]> {
  const [overrides] = useShortcutOverrides();
  return useMemo(() => resolve(overrides), [overrides]);
}

/** The first binding of one action (what menus and tooltips show), or undefined when the user removed it. */
export function useBinding(id: ShortcutId): string | undefined {
  return useBindings()[id][0];
}

/** "Undo (⌘Z)", or just "Undo" when the user has unbound it: for messages that tell the user how to take something back. */
export function undoHint(): string {
  const b = currentBindings().undo[0];
  return b ? `Undo (${bindingText(b)})` : "Undo";
}
