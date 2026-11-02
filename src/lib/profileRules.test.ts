import { describe, expect, it } from "vitest";
import { patternMatches, profileFor, remoteKey } from "./profileRules";

describe("remoteKey", () => {
  it("normalises https, ssh and scp-style remotes to host/owner/repo", () => {
    for (const url of [
      "https://github.com/Acme/App.git",
      "https://user:pw@github.com/acme/app",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:2222/acme/app.git",
      "git@github.com:acme/app.git",
      "https://github.com/acme/app/",
    ]) {
      expect(remoteKey(url), url).toBe("github.com/acme/app");
    }
  });

  it("returns null for things that are not hosted remotes", () => {
    expect(remoteKey("")).toBeNull();
    expect(remoteKey("just-a-name")).toBeNull();
    expect(remoteKey("https://github.com")).toBeNull();
  });
});

describe("patternMatches", () => {
  it("treats * as a wildcard and everything else literally, ignoring case", () => {
    expect(patternMatches("github.com/acme/*", "github.com/acme/app")).toBe(true);
    expect(patternMatches("GitHub.com/ACME/*", "github.com/acme/app")).toBe(true);
    expect(patternMatches("github.com/acme/*", "github.com/other/app")).toBe(false);
    expect(patternMatches("*/acme/*", "gitlab.com/acme/x")).toBe(true);
    expect(patternMatches("github.com/a.c/x", "github.com/abc/x")).toBe(false);
    expect(patternMatches("github.com/acme/app", "github.com/acme/app2")).toBe(false);
    expect(patternMatches("(evil+", "(evil+")).toBe(true);
  });
});

describe("profileFor", () => {
  const rules = [
    { pattern: "github.com/acme/*", profileId: "work" },
    { pattern: "github.com/*", profileId: "home" },
  ];
  it("prefers an explicit pin, then the first matching rule in order", () => {
    expect(profileFor("pinned", rules, ["https://github.com/acme/app.git"])).toBe("pinned");
    expect(profileFor(null, rules, ["https://github.com/acme/app.git"])).toBe("work");
    expect(profileFor(null, rules, ["git@github.com:me/blog.git"])).toBe("home");
    expect(profileFor(null, rules, ["https://gitlab.com/x/y"])).toBeNull();
    expect(profileFor(null, [], ["https://github.com/acme/app"])).toBeNull();
  });

  it("looks at every remote", () => {
    expect(profileFor(null, rules, ["https://gitlab.com/x/y", "git@github.com:acme/z.git"])).toBe("work");
  });
});
