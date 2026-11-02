// End-to-end tests for managing repositories: favorites and names, upkeep, tab sets per profile and
// links that open a repository. Each suite starts the production executable with its own app data.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { git, launch, makeFixture, scratchDir } from "./harness.mjs";

/** Waits until `check` is true, for state that git or the file system settles a moment after a click. */
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Perseus keeping track of repositories", () => {
  let app;
  let page;
  let repo;
  const listed = () => JSON.parse(readFileSync(join(app.appdata, "recents.json"), "utf8")).find((r) => r.name === "fixture");

  before(async () => {
    repo = makeFixture(scratchDir("perseus-keep-"));
    app = await launch({ recents: [{ path: repo, name: "fixture" }], port: 9453 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("marks a favorite on the welcome screen and lists it under Favorites", async () => {
    await page.getByRole("button", { name: "Add fixture to favorites" }).click();
    const favorites = page.getByRole("region", { name: "Favorite repositories" });
    await favorites.getByText("fixture", { exact: true }).waitFor();
    await until(() => listed()?.favorite === true, "the favorite mark is saved");
  });

  it("gives the repository a name of its own, shown in the list, the tab and the toolbar", async () => {
    await page.getByRole("button", { name: "Rename fixture" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Billing");
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.getByRole("region", { name: "Favorite repositories" }).getByText("Billing", { exact: true }).waitFor();
    await until(() => listed()?.alias === "Billing", "the name is saved");
    assert.equal(listed().name, "fixture", "the folder name is kept next to the alias");

    await page.locator(".recent-main", { hasText: "Billing" }).click();
    await page.locator(".graph-scroller").waitFor();
    await page.locator(".repo-tab", { hasText: "Billing" }).waitFor();
    await page.getByRole("button", { name: "Switch repository" }).filter({ hasText: "Billing" }).waitFor();
  });

  it("changes the favorite mark and the name from the tab's menu and by double-clicking it", async () => {
    await page.locator(".repo-tab .tab-star").waitFor();
    await page.locator(".repo-tab", { hasText: "Billing" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
    await page.locator(".repo-tab .tab-star").waitFor({ state: "detached" });
    await until(() => listed()?.favorite === false, "the mark is removed");

    await page.locator(".repo-tab-main", { hasText: "Billing" }).dblclick();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByLabel("Name").inputValue(), "Billing");
    await dialog.getByLabel("Name").fill("");
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.locator(".repo-tab", { hasText: "fixture" }).waitFor();
    await until(() => !listed()?.alias, "clearing the name goes back to the folder's");
  });

  it("shows the size of the repository and optimizes it", async () => {
    const loose = () => Number(git(repo, "count-objects", "-v").match(/count: (\d+)/)[1]);
    assert.ok(loose() > 0, "the fixture starts with loose objects");

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("maintenance");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/loose objects/).waitFor();

    await dialog.getByRole("button", { name: "Optimize the repository" }).click();
    await dialog.getByText("Optimize the repository: finished.").waitFor({ timeout: 30000 });
    assert.equal(loose(), 0, "git packed the loose objects");
    await dialog.getByText(/packed in 1 pack/).waitFor();
    assert.match(git(repo, "log", "--oneline"), /Merge topic/, "history is intact");

    await dialog.getByRole("button", { name: "Rebuild the commit graph file" }).click();
    await dialog.getByText("Rebuild the commit graph file: finished.").waitFor({ timeout: 30000 });
    await dialog.locator(".stat", { hasText: "commit graph file" }).getByText("Yes").waitFor();

    await dialog.getByRole("button", { name: "Check integrity" }).click();
    await dialog.getByText("Check integrity: finished.").waitFor({ timeout: 30000 });
    await dialog.getByLabel("Output").getByText("No problems found.").waitFor();
  });

  it("reports damage found by the integrity check", async () => {
    const dialog = page.getByRole("dialog");
    // A loose object whose contents are not a git object, left behind in the object store.
    const stray = join(repo, "..", "stray.txt");
    writeFileSync(stray, "something that git will store\n");
    const id = git(repo, "hash-object", "-w", stray).trim();
    const object = join(repo, ".git", "objects", id.slice(0, 2), id.slice(2));
    chmodSync(object, 0o666);
    writeFileSync(object, "this is not a git object");

    await dialog.getByRole("button", { name: "Check integrity" }).click();
    await dialog.getByText("Git reported problems:").waitFor({ timeout: 30000 });
    rmSync(object, { force: true });
    await dialog.locator(".dialog-foot").getByRole("button", { name: "Close" }).click();
    await dialog.waitFor({ state: "detached" });
  });
});

describe("Perseus keeping tabs per profile", () => {
  let app;
  let page;
  let first;
  let second;
  const labels = () => page.locator(".repo-tab-main span").allTextContents();
  const profile = async (name) => {
    await page.getByRole("button", { name: "Active profile" }).click();
    // The profiles are choices of one, so the menu marks them as radio items.
    await page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
  };
  const openFromPicker = async (name) => {
    await page.getByRole("button", { name: "Switch repository" }).click();
    await page.locator(".pk-item", { hasText: name }).click();
    await page.locator(".repo-tab.active", { hasText: name }).waitFor();
  };

  before(async () => {
    const root = scratchDir("perseus-tabsets-");
    first = makeFixture(root);
    second = join(root, "second");
    mkdirSync(second);
    git(second, "init", "-q", "-b", "main");
    writeFileSync(join(second, "s.txt"), "second\n");
    git(second, "add", "-A");
    git(second, "commit", "-q", "-m", "Second repository");
    app = await launch({
      recents: [
        { path: first, name: "fixture" },
        { path: second, name: "second" },
      ],
      profiles: {
        profiles: [
          { id: "p-work", name: "Work", user_name: "Work Person", user_email: "work@example.com" },
          { id: "p-home", name: "Home", user_name: "Home Person", user_email: "home@example.com" },
        ],
        active: "p-work",
      },
      port: 9454,
    });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("starts a profile with the repository in front, and keeps the other profile's tabs for later", async () => {
    await page.locator(".recent-main", { hasText: "fixture" }).click();
    await page.locator(".repo-tab.active", { hasText: "fixture" }).waitFor();
    await openFromPicker("second");
    assert.deepEqual(await labels(), ["fixture", "second"]);

    await profile("Home");
    await page.getByText("Profile switched").waitFor();
    await until(async () => (await labels()).length === 1, "Home starts with one tab");
    assert.deepEqual(await labels(), ["second"]);
  });

  it("brings each profile's tabs back, and the repository that was in front", async () => {
    await openFromPicker("fixture");
    assert.deepEqual(await labels(), ["second", "fixture"]);

    // Wait on the tabs themselves: the "tabs restored" toast of the first switch may still be showing.
    const tabsAre = (...names) => until(async () => (await labels()).join() === names.join(), `tabs ${names.join(", ")}`);
    await profile("Work");
    await tabsAre("fixture", "second");
    await page.locator(".repo-tab.active", { hasText: "second" }).waitFor();

    await profile("Home");
    await tabsAre("second", "fixture");
    await page.locator(".repo-tab.active", { hasText: "fixture" }).waitFor();
  });
});

describe("Perseus opening a link", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    repo = makeFixture(scratchDir("perseus-link-"));
    const first = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
    const link = `perseus-app://open?path=${encodeURIComponent(repo)}&commit=${first.slice(0, 10)}`;
    app = await launch({ recents: [{ path: repo, name: "fixture" }], port: 9455, args: [link] });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("opens the repository the link names and selects its commit, without any click", async () => {
    await page.locator(".repo-tab", { hasText: "fixture" }).waitFor({ timeout: 20000 });
    await page.locator(".detail-title", { hasText: "Add a" }).waitFor({ timeout: 20000 });
  });
});
