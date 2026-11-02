import { describe, expect, it } from "vitest";
import type { RecentRepo } from "../ipc";
import { kibytes, perseusLink, repoLabel, restoreTabs, splitRecents, swapTabSets, tabLabel, tabSetKey } from "./repos";

const repo = (path: string, over: Partial<RecentRepo> = {}): RecentRepo => ({
  path,
  name: path.split("/").pop() ?? path,
  last_opened: 0,
  exists: true,
  favorite: false,
  alias: null,
  ...over,
});

describe("repository names", () => {
  it("prefers the alias and falls back to the folder name", () => {
    expect(repoLabel(repo("/a/api", { alias: "Billing API" }))).toBe("Billing API");
    expect(repoLabel(repo("/a/api", { alias: "" }))).toBe("api");
    expect(repoLabel(repo("/a/api"))).toBe("api");
  });

  it("names a tab after the alias, and after its own name when the repository is no longer listed", () => {
    const list = [repo("/a/api", { alias: "Billing API" })];
    expect(tabLabel({ path: "/a/api", name: "api" }, list)).toBe("Billing API");
    expect(tabLabel({ path: "/b/web", name: "web" }, list)).toBe("web");
  });
});

describe("favorites", () => {
  it("lists favorites alphabetically by the name shown, apart from the rest", () => {
    const list = [
      repo("/a/zeta", { favorite: true }),
      repo("/a/recent"),
      repo("/a/alpha", { favorite: true, alias: "Mango" }),
      repo("/a/beta", { favorite: true }),
      repo("/a/older"),
    ];
    const { favorites, others } = splitRecents(list);
    expect(favorites.map((r) => repoLabel(r))).toEqual(["beta", "Mango", "zeta"]);
    expect(others.map((r) => r.path)).toEqual(["/a/recent", "/a/older"]);
  });
});

describe("tab sets per profile", () => {
  const set = (...paths: string[]) => ({ tabs: paths.map((p) => ({ path: p, name: p })), last: paths[0] ?? null });

  it("keeps the tabs of the profile being left and brings back the other's", () => {
    const sets = { work: set("/w1", "/w2") };
    const { sets: saved, next } = swapTabSets(sets, "home", "work", set("/h1"));
    expect(saved.home.tabs.map((t) => t.path)).toEqual(["/h1"]);
    expect(next?.tabs.map((t) => t.path)).toEqual(["/w1", "/w2"]);
    // The caller's object is not modified.
    expect(sets).toEqual({ work: set("/w1", "/w2") });
  });

  it("has nothing to restore for a profile seen for the first time", () => {
    expect(swapTabSets({}, null, "work", set("/h1")).next).toBeNull();
  });

  it("treats the system configuration as its own set", () => {
    expect(tabSetKey(null)).toBe("");
    const { sets, next } = swapTabSets({ "": set("/s1") }, "work", null, set("/w1"));
    expect(next?.tabs[0].path).toBe("/s1");
    expect(sets.work.tabs[0].path).toBe("/w1");
  });

  it("does not swap a profile with itself", () => {
    const { next } = swapTabSets({ work: set("/w1") }, "work", "work", set("/w9"));
    expect(next).toBeNull();
  });

  it("restores only tabs that can still be opened, showing the remembered one if it survives", () => {
    const saved = { tabs: set("/a", "/b", "/c").tabs, last: "/b" };
    expect(restoreTabs(saved, () => true)).toEqual({ tabs: saved.tabs, show: "/b" });
    expect(restoreTabs(saved, (p) => p !== "/b")).toEqual({
      tabs: [saved.tabs[0], saved.tabs[2]],
      show: "/c",
    });
    expect(restoreTabs(saved, () => false)).toEqual({ tabs: [], show: null });
  });
});

describe("links", () => {
  it("encodes the folder and the commit into an address that the backend reads back", () => {
    expect(perseusLink(String.raw`C:\My Repos\app`)).toBe("perseus-app://open?path=C%3A%5CMy+Repos%5Capp");
    expect(perseusLink("/home/me/app", "ABC123")).toBe("perseus-app://open?path=%2Fhome%2Fme%2Fapp&commit=ABC123");
    // Whatever the folder is called, it stays inside its own query value.
    const tricky = perseusLink("/x&commit=1234&path=/evil#frag");
    const parsed = new URL(tricky);
    expect(parsed.searchParams.get("path")).toBe("/x&commit=1234&path=/evil#frag");
    expect(parsed.searchParams.get("commit")).toBeNull();
  });
});

describe("sizes", () => {
  it("writes git's KiB counts for people", () => {
    expect(kibytes(0)).toBe("0 KiB");
    expect(kibytes(512)).toBe("512 KiB");
    expect(kibytes(1536)).toBe("1.5 MiB");
    expect(kibytes(250 * 1024)).toBe("250 MiB");
    expect(kibytes(3 * 1024 * 1024)).toBe("3.0 GiB");
  });
});
