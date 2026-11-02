// End-to-end tests against the production executable. Run `pnpm tauri build --no-bundle`
// first, then `pnpm e2e`. Windows only (WebView2 exposes the DevTools protocol).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { git, launch, makeFixture, rowPoint, scratchDir } from "./harness.mjs";

describe("Perseus", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    repo = makeFixture(scratchDir("perseus-fixture-"));
    app = await launch({ recents: [{ path: repo, name: "fixture" }] });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("shows the welcome screen with the recent repository", async () => {
    await page.getByRole("heading", { name: "Perseus" }).waitFor();
    await page.locator(".recent-main", { hasText: "fixture" }).waitFor();
  });

  it("opens the repository and draws the history", async () => {
    await page.locator(".recent-main", { hasText: "fixture" }).click();
    await page.locator(".graph-scroller").waitFor();
    await page.getByText(/4 commits/).waitFor();
    const canvas = await page.locator(".graph-canvas").boundingBox();
    assert.ok(canvas.width > 300 && canvas.height > 100, "the graph canvas has a size");
    const painted = await page.evaluate(() => {
      const c = document.querySelector(".graph-canvas");
      const px = c.getContext("2d").getImageData(0, 0, c.width, 200).data;
      return px.some((v, i) => i % 4 === 3 && v > 0);
    });
    assert.ok(painted, "the canvas has painted pixels");
  });

  it("shows commit details when a row is clicked", async () => {
    const { x, y } = await rowPoint(page, 0);
    await page.mouse.click(x, y);
    await page.locator(".detail-title", { hasText: "Merge topic" }).waitFor();
  });

  it("notices an external file edit without any refresh", async () => {
    writeFileSync(join(repo, "a.txt"), "edited outside the app\n");
    // The Changes badge appears once the watcher reports and the status reloads.
    await page.locator('[role="tab"]', { hasText: "Changes" }).locator(".badge").waitFor({ timeout: 8000 });
  });

  it("stages a file and commits it", async () => {
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    // The box flips only after git has staged the file and the status reloaded.
    await page.getByLabel("Stage a.txt").click();
    await page.getByLabel("Unstage a.txt").waitFor();
    await page.getByLabel("Commit summary").fill("Edit a from the e2e test");
    await page.getByLabel("Commit summary").press("Control+Enter");
    await page.getByText("Committed", { exact: true }).waitFor();
    assert.match(git(repo, "log", "-1", "--format=%s"), /Edit a from the e2e test/);
    await page.getByText(/5 commits/).waitFor();
  });

  it("stashes working changes from the dialog and applies them again", async () => {
    writeFileSync(join(repo, "b.txt"), "work in progress\n");
    await page.locator('[role="tab"]', { hasText: "Changes" }).locator(".badge").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Stash changes…" }).click();
    await page.getByLabel("Message (optional)").fill("e2e stash");
    await page.getByRole("button", { name: "Stash", exact: true }).click();
    await page.getByText("Changes stashed").waitFor();
    assert.equal(git(repo, "status", "--porcelain").trim(), "", "the working tree is clean again");
    await page.getByRole("button", { name: /Stashes/ }).waitFor();

    await page.locator(".side-row", { hasText: "e2e stash" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Pop/ }).click();
    await page.getByText("Stash pop done").waitFor();
    assert.match(git(repo, "status", "--porcelain"), /b\.txt/);
  });

  it("asks before discarding, then restores the file", async () => {
    // b.txt is a modified tracked file from the previous test's pop.
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "Track b");
    writeFileSync(join(repo, "b.txt"), "scribbles\n");
    await page.getByLabel("Discard changes to b.txt").waitFor({ timeout: 8000 });
    await page.getByLabel("Discard changes to b.txt").click({ force: true });
    await page.getByRole("dialog").getByText("This cannot be undone.").waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
    await page.getByText("Discard done").waitFor();
    assert.equal(git(repo, "status", "--porcelain").trim(), "");
  });

  it("creates a tag from the commit context menu", async () => {
    // The "Discard done" toast appears a moment before the status refresh removes the working-tree
    // row, so the first click can land on that row (which has no menu). Retry like a user would.
    const { x, y } = await rowPoint(page, 0);
    for (let attempts = 0; attempts < 3; attempts++) {
      await page.mouse.click(x, y, { button: "right" });
      if (await page.locator('[role="menu"]').waitFor({ timeout: 1500 }).then(() => true, () => false)) break;
    }
    await page.getByRole("menuitem", { name: /Create tag here/ }).click({ timeout: 5000 });
    await page.getByLabel("Tag name").fill("e2e-tag");
    await page.getByRole("dialog").getByRole("button", { name: "Create tag" }).click();
    await page.getByText("Tag create done").waitFor();
    assert.match(git(repo, "tag", "--list"), /e2e-tag/);
  });

  it("opens a context menu on right-click", async () => {
    const { x, y } = await rowPoint(page, 2);
    await page.mouse.click(x, y, { button: "right" });
    await page.locator('[role="menu"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator('[role="menu"]').waitFor({ state: "detached" });
  });

  it("answers a drag onto another commit with a dialog or an explanation", async () => {
    const from = await rowPoint(page, 3);
    const to = await rowPoint(page, 0);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 40, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await page.locator('[role="dialog"], .toast').first().waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  it("opens the command palette and switches the theme", async () => {
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("theme light");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("theme dark");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  });

  it("logs nothing worse than the known isolation-iframe CSP entries", async () => {
    const unexpected = app.consoleErrors.filter((m) => !/Applying inline style violates/.test(m));
    assert.deepEqual(unexpected, []);
  });
});

// Every chunk of history is larger than Tauri's 8 KiB direct-message threshold, so it travels
// through the framework's channel-fetch command. The isolation hook once blocked that command
// and a real repository showed up empty; a four-commit fixture can never catch it.
describe("Perseus with a long history", () => {
  let app;

  before(async () => {
    const dir = join(scratchDir("perseus-big-"), "big");
    execFileSync("node", ["scripts/make-perf-repo.mjs", dir, "1200"], { stdio: "ignore" });
    app = await launch({ recents: [{ path: dir, name: "big" }], port: 9445 });
  });

  after(async () => {
    await app?.stop();
  });

  it("loads every commit and scrolls to the oldest one", async () => {
    const page = app.page;
    await page.locator(".recent-main", { hasText: "big" }).click();
    await page.getByText(/1.?200 commits/).waitFor({ timeout: 30000 });
    const rows = await page.evaluate(() => {
      const sc = document.querySelector(".graph-scroller");
      return Math.round((sc.scrollHeight - sc.clientHeight) / 32);
    });
    assert.ok(rows > 1000, `the scroll extent covers the history (${rows} rows)`);
    assert.equal(await page.getByText("No commits yet").count(), 0);
  });
});
