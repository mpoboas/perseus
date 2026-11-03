import { describe, expect, it } from "vitest";
import { catalogs, resolveLocale, systemLocale, translate } from "./index";
import { en } from "./en";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogues", () => {
  it("Portuguese translates every English message and invents none", () => {
    const pt = catalogs["pt-PT"] as Record<string, string>;
    const missing = Object.keys(en).filter((k) => !(k in pt));
    const extra = Object.keys(pt).filter((k) => !(k in en));
    expect(missing, "not translated").toEqual([]);
    expect(extra, "no such message in English").toEqual([]);
  });

  it("keeps the placeholders of every message", () => {
    const pt = catalogs["pt-PT"] as Record<string, string>;
    for (const [key, text] of Object.entries(en)) expect(placeholders(pt[key]), key).toEqual(placeholders(text));
  });

  it("has no empty messages", () => {
    for (const [lang, catalog] of Object.entries(catalogs))
      for (const [key, text] of Object.entries(catalog)) expect(text?.trim(), `${lang}: ${key}`).not.toBe("");
  });
});

describe("translate", () => {
  it("fills in placeholders", () => {
    expect(translate("en", "welcome.rename", { name: "perseus" })).toBe("Rename perseus");
    expect(translate("pt-PT", "welcome.rename", { name: "perseus" })).toBe("Mudar o nome de perseus");
  });

  it("leaves an unknown placeholder visible rather than printing undefined", () => {
    expect(translate("en", "welcome.rename")).toBe("Rename {name}");
    expect(translate("en", "welcome.rename", { other: 1 })).toBe("Rename {name}");
  });

  it("falls back to English for a missing message, then to the key", () => {
    expect(translate("pt-PT", "no.such.key")).toBe("no.such.key");
    const original = (catalogs["pt-PT"] as Record<string, string>)["tb.undo"];
    delete (catalogs["pt-PT"] as Record<string, string>)["tb.undo"];
    expect(translate("pt-PT", "tb.undo")).toBe("Undo");
    (catalogs["pt-PT"] as Record<string, string>)["tb.undo"] = original;
  });

  it("is not fooled by braces that are not placeholders", () => {
    expect(translate("en", "status.reading", { count: "1,807" })).toBe("Reading history… 1,807 commits");
  });
});

describe("locale", () => {
  it("follows the system's first language we have", () => {
    expect(systemLocale(["pt-PT", "en"])).toBe("pt-PT");
    expect(systemLocale(["pt-BR"])).toBe("pt-PT");
    expect(systemLocale(["fr", "en-GB"])).toBe("en");
    expect(systemLocale(["ja"])).toBe("en");
    expect(systemLocale([])).toBe("en");
  });

  it("an explicit choice beats the system", () => {
    expect(resolveLocale("en", "pt-PT")).toBe("en");
    expect(resolveLocale("pt-PT", "en")).toBe("pt-PT");
    expect(resolveLocale("system", "pt-PT")).toBe("pt-PT");
  });
});
