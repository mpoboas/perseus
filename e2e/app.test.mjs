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
