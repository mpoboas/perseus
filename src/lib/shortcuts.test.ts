import { describe, expect, it } from "vitest";
import {
  type KeyEventLike,
  SHORTCUTS,
  actionFor,
  bindingFromEvent,
  bindingProblem,
  bindingText,
  conflictFor,
  displayKeys,
  matches,
  parseBinding,
  resolve,
} from "./shortcuts";

const ev = (key: string, mods: Partial<KeyEventLike> = {}, code = ""): KeyEventLike => ({
  key,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("parseBinding", () => {
  it("reads modifiers and the key", () => {
    expect(parseBinding("Mod+Shift+Z")).toMatchObject({ mod: true, shift: true, key: "z" });
    expect(parseBinding("F5")).toMatchObject({ mod: false, key: "f5" });
    expect(parseBinding("Mod+Plus")).toMatchObject({ mod: true, key: "plus" });
  });

  it("refuses nonsense", () => {
    expect(parseBinding("")).toBeNull();
    expect(parseBinding("Mod+")).toBeNull();
    expect(parseBinding("Hyper+K")).toBeNull();
    expect(parseBinding("Mod+Shift")).toBeNull();
  });
});

describe("matches", () => {
  it("uses Command as Mod on a Mac and Control elsewhere", () => {
    expect(matches(ev("k", { metaKey: true }), "Mod+K", true)).toBe(true);
    expect(matches(ev("k", { ctrlKey: true }), "Mod+K", true)).toBe(false);
    expect(matches(ev("k", { ctrlKey: true }), "Mod+K", false)).toBe(true);
    expect(matches(ev("k", { metaKey: true }), "Mod+K", false)).toBe(false);
  });

  it("is strict about Shift for letters", () => {
    expect(matches(ev("z", { ctrlKey: true }), "Mod+Z", false)).toBe(true);
    expect(matches(ev("Z", { ctrlKey: true, shiftKey: true }), "Mod+Z", false)).toBe(false);
    expect(matches(ev("Z", { ctrlKey: true, shiftKey: true }), "Mod+Shift+Z", false)).toBe(true);
  });

  it("ignores Shift for symbols, whose shifted state depends on the layout", () => {
    expect(matches(ev("?", { shiftKey: true }), "?", false)).toBe(true);
    expect(matches(ev("+", { ctrlKey: true, shiftKey: true }), "Mod+Plus", false)).toBe(true);
    expect(matches(ev("=", { ctrlKey: true }), "Mod+=", false)).toBe(true);
  });

  it("does not fire with extra modifiers held", () => {
    expect(matches(ev("k", { ctrlKey: true, altKey: true }), "Mod+K", false)).toBe(false);
  });

  it("reads Option+letter from the key's position, since macOS types another character", () => {
    expect(matches(ev("˚", { altKey: true }, "KeyK"), "Alt+K", true)).toBe(true);
  });
});

describe("bindingFromEvent", () => {
  it("round-trips through matches", () => {
    for (const [e, mac] of [
      [ev("k", { ctrlKey: true }), false],
      [ev("k", { metaKey: true }), true],
      [ev("Z", { metaKey: true, shiftKey: true }), true],
      [ev("F5"), false],
      [ev("?", { shiftKey: true }), false],
      [ev("+", { ctrlKey: true, shiftKey: true }), false],
      [ev("Enter", { ctrlKey: true }), false],
    ] as [KeyEventLike, boolean][]) {
      const b = bindingFromEvent(e, mac);
      expect(b, JSON.stringify(e)).not.toBeNull();
      expect(matches(e, b!, mac), b!).toBe(true);
    }
  });

  it("records the real Control key on a Mac as Ctrl, not Mod", () => {
    expect(bindingFromEvent(ev("k", { ctrlKey: true }), true)).toBe("Ctrl+K");
  });

  it("ignores a lone modifier key", () => {
    expect(bindingFromEvent(ev("Control", { ctrlKey: true }), false)).toBeNull();
    expect(bindingFromEvent(ev("Shift", { shiftKey: true }), false)).toBeNull();
  });
});

describe("bindingProblem", () => {
  it("accepts shortcuts that are safe", () => {
    for (const b of ["Mod+K", "F5", "?", "Alt+Enter", "Mod+Shift+P"]) expect(bindingProblem(b), b).toBeNull();
  });

  it("rejects a bare letter, Esc and Tab", () => {
    expect(bindingProblem("K")).toMatch(/typed into text boxes/);
    expect(bindingProblem("Escape")).toMatch(/cancel/);
    expect(bindingProblem("Tab")).toMatch(/controls/);
  });
});

describe("resolve and conflicts", () => {
  it("uses the defaults, and a user's own list instead of them", () => {
    expect(resolve({}).palette).toEqual(["Mod+K", "Mod+P"]);
    expect(resolve({ palette: ["Mod+Shift+P"] }).palette).toEqual(["Mod+Shift+P"]);
    expect(resolve({ palette: [] }).palette).toEqual([]);
  });

  it("drops stored bindings that no longer parse", () => {
    expect(resolve({ open: ["Hyper+O", "Mod+O"] }).open).toEqual(["Mod+O"]);
  });

  it("ships defaults that do not clash with each other", () => {
    const seen = new Map<string, string>();
    const all = resolve({});
    for (const s of SHORTCUTS)
      for (const b of all[s.id]) {
        expect(seen.get(b), `${b} is bound to both ${seen.get(b)} and ${s.id}`).toBeUndefined();
        seen.set(b, s.id);
      }
  });

  it("finds the action that already has a binding", () => {
    const all = resolve({});
    expect(conflictFor(all, "open", "Mod+K")).toBe("palette");
    expect(conflictFor(all, "palette", "Mod+K")).toBeNull();
    expect(conflictFor(all, "open", "Mod+Shift+K")).toBeNull();
  });
});

describe("actionFor", () => {
  const all = resolve({});

  it("finds the action for an event", () => {
    expect(actionFor(ev("k", { ctrlKey: true }), all, false, false)).toBe("palette");
    expect(actionFor(ev("y", { ctrlKey: true }), all, false, false)).toBe("redo");
    expect(actionFor(ev("F5"), all, false, false)).toBe("refresh");
  });

  it("does not fire a bare-key shortcut while typing", () => {
    expect(actionFor(ev("?", { shiftKey: true }), all, false, false)).toBe("help");
    expect(actionFor(ev("?", { shiftKey: true }), all, true, false)).toBeNull();
    expect(actionFor(ev("k", { ctrlKey: true }), all, true, false)).toBe("palette");
  });

  it("does nothing for an unbound action", () => {
    expect(actionFor(ev("o", { ctrlKey: true }), resolve({ open: [] }), false, false)).toBeNull();
  });
});

describe("display", () => {
  it("draws Mac glyphs and Windows names", () => {
    expect(displayKeys("Mod+Shift+Z", true)).toEqual(["⌘", "⇧", "Z"]);
    expect(displayKeys("Mod+Shift+Z", false)).toEqual(["Ctrl", "Shift", "Z"]);
    expect(displayKeys("Ctrl+K", true)).toEqual(["⌃", "K"]);
    expect(displayKeys("Mod+Plus", false)).toEqual(["Ctrl", "+"]);
    expect(displayKeys("F5", false)).toEqual(["F5"]);
  });

  it("writes tooltip text the way each system does", () => {
    expect(bindingText("Mod+Z", true)).toBe("⌘Z");
    expect(bindingText("Mod+Z", false)).toBe("Ctrl+Z");
  });
});
