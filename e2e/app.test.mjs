// End-to-end tests against the production executable. Run `pnpm tauri build --no-bundle`
// first, then `pnpm e2e`. Windows only (WebView2 exposes the DevTools protocol).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { git, launch, makeFixture, rowPoint, scratchDir } from "./harness.mjs";

/** Waits until `check` is true, for state that git or the file system settles a moment after a click. */
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Lets the app finish refreshing after an action (file-watcher events arrive a moment later). */
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** A solid-colour PNG of the given size, built by hand so the tests need no image files. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.writeUInt8(8, 8); // bit depth
  head.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
    await page.getByRole("dialog").getByRole("button", { name: "Stash", exact: true }).click();
    await page.getByText("Changes stashed").waitFor();
    assert.equal(git(repo, "status", "--porcelain").trim(), "", "the working tree is clean again");
    await page.getByRole("button", { name: /Stashes/ }).waitFor();

    await page.locator(".side-row", { hasText: "e2e stash" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Pop/ }).click();
    await page.getByText("Stash pop done").waitFor();
    assert.match(git(repo, "status", "--porcelain"), /b\.txt/);

    // Undo puts the stash back and the file as it was before the pop; redo pops it once more.
    const text = () => readFileSync(join(repo, "b.txt"), "utf8").replace(/\r\n/g, "\n");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByText("Undid stash pop").waitFor();
    await until(() => git(repo, "stash", "list").includes("e2e stash"), "the stash is back");
    await until(() => text() === "b\n", "the file is as committed again");
    await settle();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByText("Redid stash pop").waitFor();
    await until(() => text() === "work in progress\n", "the pop is redone");
    assert.equal(git(repo, "stash", "list").trim(), "", "and the stash is used up again");
    await settle();
  });

  it("asks before discarding, then restores the file", async () => {
    // b.txt is a modified tracked file from the previous test's pop.
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "Track b");
    writeFileSync(join(repo, "b.txt"), "scribbles\n");
    await page.getByLabel("Discard changes to b.txt").waitFor({ timeout: 8000 });
    await page.getByLabel("Discard changes to b.txt").click({ force: true });
    await page.getByRole("dialog").getByText(/Undo \(Ctrl\+Z\) can bring this back/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
    await page.getByText("Discard done").waitFor();
    assert.equal(git(repo, "status", "--porcelain").trim(), "");

    // The discard can be undone, and redone.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByText("Undid discard").waitFor();
    await until(() => readFileSync(join(repo, "b.txt"), "utf8").replace(/\r\n/g, "\n") === "scribbles\n", "the edit is back");
    await settle();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByText("Redid discard").waitFor();
    await until(() => git(repo, "status", "--porcelain").trim() === "", "discarded again");
    await settle();
  });

  it("stages a single hunk, then single lines, from the diff view", async () => {
    const numbered = (edits = {}) =>
      Array.from({ length: 30 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(repo, "long.txt"), numbered());
    git(repo, "add", "long.txt");
    git(repo, "commit", "-q", "-m", "Add long.txt");
    writeFileSync(join(repo, "long.txt"), numbered({ 2: "CHANGED 2", 28: "CHANGED 28" }));

    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.locator(".file-main", { hasText: "long.txt" }).first().click();
    await page.getByRole("button", { name: "Stage hunk" }).last().click();
    await page.getByText("Staged this hunk").waitFor();
    const cached = git(repo, "diff", "--cached", "--unified=0");
    assert.match(cached, /CHANGED 28/);
    assert.doesNotMatch(cached, /CHANGED 2\n/);

    // The remaining hunk: tick its added line only and stage just that.
    await page.getByLabel("Select added line 2", { exact: true }).check();
    await page.getByRole("button", { name: "Stage lines" }).click();
    await page.getByText(/Staged 1 line/).waitFor();
    assert.match(git(repo, "diff", "--cached", "--unified=0"), /CHANGED 2\n/);
    // The index now holds the whole edit for this file; the working tree is unchanged.
    assert.equal(git(repo, "diff", "--name-only").trim(), "long.txt", "the deletion of 'line 2' is still unstaged");
    git(repo, "add", "long.txt");
    git(repo, "commit", "-q", "-m", "Edit long.txt");
  });

  it("pre-fills the commit box when amending and appends co-author trailers", async () => {
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.getByLabel("Amend the last commit").check();
    await page.getByLabel("Commit summary").waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Commit summary"]').value === "Edit long.txt");

    await page.getByRole("button", { name: "Add co-authors…" }).click();
    await page.getByLabel("Co-author").fill("Grace Hopper <grace@example.com>");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Commit summary").press("Control+Enter");
    await page.getByText("Amended the last commit").waitFor();
    assert.match(git(repo, "log", "-1", "--format=%B"), /Co-authored-by: Grace Hopper <grace@example\.com>/);
  });

  it("shows a file's history and blame", async () => {
    const { x, y } = await rowPoint(page, 0);
    await page.mouse.click(x, y);
    await page.locator('[role="tab"]', { hasText: "Commit" }).click();
    await page.getByLabel("History of long.txt").click({ force: true, timeout: 6000 }).catch(async (e) => {
      if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "history-fail.png") });
      throw e;
    });
    await page.getByRole("dialog").getByText("Edit long.txt").waitFor();
    await page.getByRole("dialog").getByText("Add long.txt").waitFor();
    await page.getByRole("radio", { name: "Blame" }).click();
    await page.getByRole("dialog").getByText("line 15").waitFor();
    await page.keyboard.press("Escape");
  });

  it("shows the open repository as a tab", async () => {
    await page.locator('.repo-tab.active', { hasText: "fixture" }).waitFor();
  });

  it("searches commits by message and jumps to the result", async () => {
    await page.keyboard.press("Control+f");
    await page.getByLabel("Message contains").fill("merge TOPIC");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("list", { name: "Search results" }).getByText("Merge topic").click();
    await page.locator(".detail-title", { hasText: "Merge topic" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "the dialog closes after jumping");
  });

  it("hides a branch from the graph through the sidebar menu and restores it", async () => {
    await page.locator(".side-row", { hasText: "topic" }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: /Hide topic from the graph/ }).click();
    await page.getByText("Graph filtered (1)").waitFor();
    await page.locator(".side-row.hidden-ref", { hasText: "topic" }).waitFor();
    await page.getByText("Graph filtered (1)").click();
    await page.getByText("Graph filtered (1)").waitFor({ state: "detached" });
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

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(() => !git(repo, "tag", "--list").includes("e2e-tag"), "the tag is removed");
    await settle();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await until(() => git(repo, "tag", "--list").includes("e2e-tag"), "the tag is back");
    await settle();
  });

  it("keeps the graph after many outside ref changes in a row", async () => {
    // Each change triggers a quiet reload; the result of a reload can arrive before its last rows.
    for (let n = 0; n < 15; n++) {
      git(repo, "tag", `churn-${n}`);
      await new Promise((r) => setTimeout(r, 450));
      git(repo, "tag", "-d", `churn-${n}`);
      await new Promise((r) => setTimeout(r, 450));
    }
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await page.getByText("No commits yet").count(), 0, "the graph did not blank");
    const painted = await page.evaluate(() => {
      const c = document.querySelector(".graph-canvas");
      const px = c.getContext("2d").getImageData(0, 0, c.width, 200).data;
      return px.some((v, i) => i % 4 === 3 && v > 0);
    });
    assert.ok(painted, "the canvas still has painted rows");
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

  it("checks out a branch when its label in the graph is double-clicked", async () => {
    const before = git(repo, "branch", "--show-current").trim();
    // The label sits at the left of its commit's row; try the first few rows for the one on "topic".
    for (let i = 1; i <= 5 && git(repo, "branch", "--show-current").trim() === before; i++) {
      const { x, y } = await rowPoint(page, i);
      await page.mouse.dblclick(x - 400 + 30, y);
      for (let n = 0; n < 15 && git(repo, "branch", "--show-current").trim() === before; n++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.notEqual(git(repo, "branch", "--show-current").trim(), before, "a branch was checked out");
    git(repo, "switch", "-q", before);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("undoes and redoes creating a branch", async () => {
    const before = git(repo, "branch", "--show-current").trim();
    await page.getByRole("button", { name: "Branch", exact: true }).click();
    await page.getByLabel("Branch name").fill("undo-me");
    await page.getByRole("button", { name: "Create and check out" }).click();
    await page.getByText("Created undo-me").waitFor();
    assert.equal(git(repo, "branch", "--show-current").trim(), "undo-me");

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByText("Undid new branch").waitFor();
    assert.equal(git(repo, "branch", "--show-current").trim(), before, "back on the original branch");
    assert.doesNotMatch(git(repo, "branch", "--list"), /undo-me/, "the branch is gone");

    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByText("Redid new branch").waitFor();
    assert.equal(git(repo, "branch", "--show-current").trim(), "undo-me");

    // The first toast may still be on screen, so wait for git itself rather than for the text.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    for (let i = 0; i < 50 && git(repo, "branch", "--show-current").trim() !== before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(git(repo, "branch", "--show-current").trim(), before);
  });

  it("lists the other repositories in the repository picker", async () => {
    await page.getByRole("button", { name: "Switch repository" }).click();
    await page.getByText("Recently opened").waitFor();
    // The fixture is the only recent repository and it is the open one.
    await page.getByText("No other repositories yet").waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("Recently opened").waitFor({ state: "detached" });
  });

  it("switches branch from the branch picker, filtering as you type", async () => {
    const before = git(repo, "branch", "--show-current").trim();
    await page.getByRole("button", { name: "Switch branch" }).click();
    // The branch being worked on is marked.
    await page.locator(".pk-item.current", { hasText: before }).waitFor();
    await page.getByRole("textbox", { name: "Search" }).fill("topi");
    await page.locator(".pk-item", { hasText: "main" }).waitFor({ state: "detached" });
    await page.locator(".pk-item", { hasText: "topic" }).click();
    for (let n = 0; n < 50 && git(repo, "branch", "--show-current").trim() !== "topic"; n++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(git(repo, "branch", "--show-current").trim(), "topic");
    git(repo, "switch", "-q", before);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("warns about conflicts with the main branch, and says when there are none", async () => {
    // `clash` and main both rewrite a.txt; `clean` only adds a file.
    git(repo, "switch", "-q", "-c", "clash");
    writeFileSync(join(repo, "a.txt"), "the clash side\n");
    git(repo, "commit", "-q", "-am", "Clash side");
    git(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "the main side\n");
    git(repo, "commit", "-q", "-am", "Main side");
    git(repo, "switch", "-q", "clash");

    const button = page.getByRole("button", { name: "Conflict detection" });
    await button.locator(".conflict-count").waitFor({ timeout: 10000 });
    await button.hover();
    await page.getByRole("tooltip").getByText("1 file would conflict").waitFor();
    await page.getByRole("tooltip").getByText("a.txt").waitFor();

    git(repo, "switch", "-q", "main");
    git(repo, "switch", "-q", "-c", "clean");
    writeFileSync(join(repo, "extra.txt"), "no overlap\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Clean side");
    await button.locator(".conflict-count").waitFor({ state: "detached", timeout: 10000 });
    await page.mouse.move(5, 300);
    await button.hover();
    await page.getByRole("tooltip").getByText("No conflicts detected against").waitFor();
    await page.getByRole("tooltip").locator(".tip-ref", { hasText: "main" }).waitFor();

    git(repo, "switch", "-q", "main");
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("centres the action buttons between the two groups", async () => {
    const box = async (loc) => (await loc.first().boundingBox());
    // Undo is the first button of the group and Pop the last.
    const fetch = await box(page.getByRole("button", { name: "Undo", exact: true }));
    const stashPop = await box(page.getByRole("button", { name: /^Pop/ }));
    const left = await box(page.getByRole("button", { name: "Conflict detection" }));
    const right = await box(page.getByRole("button", { name: "Open command palette" }));
    const gapLeft = fetch.x - (left.x + left.width);
    const gapRight = right.x - (stashPop.x + stashPop.width);
    assert.ok(Math.abs(gapLeft - gapRight) < 40, `actions are centred (gaps ${Math.round(gapLeft)} and ${Math.round(gapRight)})`);
  });

  it("colours code, marks the changed words and lays the diff out side by side", async () => {
    writeFileSync(join(repo, "calc.js"), "const price = 3;\nexport default price;\n");
    git(repo, "add", "calc.js");
    git(repo, "commit", "-q", "-m", "Add calc.js");
    writeFileSync(join(repo, "calc.js"), "const price = 4;\nexport default price;\n");
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.locator(".file-main", { hasText: "calc.js" }).first().click();
    await page.locator(".diff-line.add .tok-kw", { hasText: "const" }).waitFor();
    await page.locator(".diff-line.add .chg", { hasText: "4" }).waitFor();
    await page.locator(".diff-line.del .chg", { hasText: "3" }).waitFor();

    await page.getByRole("radio", { name: "Side by side" }).click();
    await page.locator(".diff-line.split .half.del .chg", { hasText: "3" }).waitFor();
    await page.locator(".diff-line.split .half.add .chg", { hasText: "4" }).waitFor();
    // Lines can still be picked for staging from the split layout.
    await page.getByLabel("Select added line 1", { exact: true }).check();
    await page.getByRole("button", { name: "Stage lines" }).waitFor();
    await page.getByRole("button", { name: "Clear" }).click();

    await page.getByRole("radio", { name: "Unified" }).click();
    await page.locator(".diff-line.add").first().waitFor();
    git(repo, "checkout", "--", "calc.js");
  });

  it("shows the before and after of a changed picture", async () => {
    writeFileSync(join(repo, "logo.png"), png(2, 2, [220, 40, 40]));
    git(repo, "add", "logo.png");
    git(repo, "commit", "-q", "-m", "Add logo.png");
    writeFileSync(join(repo, "logo.png"), png(4, 4, [40, 60, 220]));
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.locator(".file-main", { hasText: "logo.png" }).first().click();
    await page.getByText("2×2", { exact: false }).first().waitFor();
    await page.getByText("4×4", { exact: false }).first().waitFor();
    const sizes = await page.evaluate(() => [...document.querySelectorAll(".img-shot")].map((i) => i.naturalWidth));
    assert.deepEqual(sizes, [2, 4], "both versions decoded");

    await page.getByRole("radio", { name: "Swipe" }).click();
    await page.locator(".img-swipe .img-shot.over").waitFor();
    git(repo, "checkout", "--", "logo.png");
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

describe("Perseus resolving a merge conflict", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    repo = join(scratchDir("perseus-conflict-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const text = (edits = {}) =>
      Array.from({ length: 8 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(repo, "f.txt"), text());
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "switch", "-q", "-c", "other");
    writeFileSync(join(repo, "f.txt"), text({ 3: "OTHER 3" }));
    git(repo, "commit", "-qam", "other change");
    git(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "f.txt"), text({ 3: "MAIN 3" }));
    git(repo, "commit", "-qam", "main change");
    try {
      git(repo, "merge", "other");
    } catch {
      /* the conflict is the point */
    }
    app = await launch({ recents: [{ path: repo, name: "repo" }], port: 9446 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("shows the paused merge and resolves the file with both versions kept", async () => {
    await page.locator(".recent-main", { hasText: "repo" }).click();
    await page.getByText("Merge in progress").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Resolve…" }).click();

    await page.getByText("Conflict 1 of 1").waitFor();
    assert.equal(await page.getByRole("button", { name: "Save and mark resolved" }).isDisabled(), true);
    await page.getByText("Yours, then theirs").click();
    await page.getByRole("button", { name: "Save and mark resolved" }).click();
    await page.getByText("Resolved f.txt").waitFor();

    const merged = readFileSync(join(repo, "f.txt"), "utf8");
    assert.match(merged, /MAIN 3\nOTHER 3\n/);
    assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
  });

  it("continues the merge from the banner", async () => {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Continued").waitFor();
    assert.match(git(repo, "log", "-1", "--format=%P").trim(), /^\S+ \S+$/, "a merge commit with two parents");
  });
});

describe("Perseus interactive rebase", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    repo = join(scratchDir("perseus-rebase-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    for (const n of ["A", "B", "C", "D"]) {
      writeFileSync(join(repo, `${n}.txt`), `${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `commit ${n}`);
    }
    app = await launch({ recents: [{ path: repo, name: "repo" }], port: 9447 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("drops one commit and rewords another from the dialog", async () => {
    await page.locator(".recent-main", { hasText: "repo" }).click();
    await page.getByText(/4 commits/).waitFor();
    // Rows are newest first: D, C, B, A. Rebase onto A.
    const { x, y } = await rowPoint(page, 3);
    await page.mouse.click(x, y, { button: "right" });
    await page.getByRole("menuitem", { name: /interactively onto here/ }).click();

    await page.getByLabel("Action for commit C").selectOption("drop");
    await page.getByLabel("Action for commit B").selectOption("reword");
    await page.getByLabel("New message for commit B").fill("B, but better");
    await page.getByRole("button", { name: "Rebase", exact: true }).click();
    await page.getByText("Rebase finished").waitFor({ timeout: 15000 });

    assert.equal(git(repo, "log", "--format=%s", "--reverse").trim(), "commit A\nB, but better\ncommit D");
    assert.equal(git(repo, "ls-files").trim().split("\n").sort().join(","), "A.txt,B.txt,D.txt");
  });
});

describe("Perseus cherry-picking several commits", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    repo = join(scratchDir("perseus-picks-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "switch", "-q", "-c", "feature");
    for (const n of ["f1", "f2", "f3"]) {
      writeFileSync(join(repo, `${n}.txt`), `${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", n);
    }
    // The branch being worked on sits at `base`, so the graph is one line: f3, f2, f1, base.
    git(repo, "switch", "-q", "-c", "target", "main");
    app = await launch({ recents: [{ path: repo, name: "repo" }], port: 9450 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  /** Clicks a commit row while holding a modifier key. */
  const clickWith = async (key, row) => {
    const { x, y } = await rowPoint(page, row);
    await page.keyboard.down(key);
    await page.mouse.click(x, y);
    await page.keyboard.up(key);
  };

  it("picks two commits in the order set in the dialog", async () => {
    await page.locator(".recent-main", { hasText: "repo" }).click();
    await page.getByText(/4 commits/).waitFor();
    // Rows, newest first: f3, f2, f1, base. Select f1, then add f3 with Ctrl.
    const f1 = await rowPoint(page, 2);
    await page.mouse.click(f1.x, f1.y);
    await clickWith("Control", 0);
    const f3 = await rowPoint(page, 0);
    await page.mouse.click(f3.x, f3.y, { button: "right" });
    await page.getByRole("menuitem", { name: /Cherry-pick 2 commits onto target/ }).click();

    const items = page.getByRole("list", { name: "Commits to cherry-pick" }).locator("li");
    assert.deepEqual(await items.locator(".pick-summary").allInnerTexts(), ["f1", "f3"], "oldest first");
    await items.first().getByRole("button", { name: "Move down" }).click();
    assert.deepEqual(await items.locator(".pick-summary").allInnerTexts(), ["f3", "f1"]);
    await page.getByRole("button", { name: "Cherry-pick 2 commits" }).click();
    await page.getByText("Cherry-picked 2 commits").waitFor();

    assert.equal(git(repo, "log", "-3", "--format=%s").trim(), "f1\nf3\nbase", "f3 was applied first, then f1");
    assert.equal(git(repo, "status", "--porcelain").trim(), "");
  });

  it("combines a range of commits into one", async () => {
    // Back to base (outside the app), so the graph is the single line again.
    git(repo, "reset", "-q", "--hard", "main");
    await settle(2500);
    const f1 = await rowPoint(page, 2);
    await page.mouse.click(f1.x, f1.y);
    await clickWith("Shift", 0);
    const f3 = await rowPoint(page, 0);
    await page.mouse.click(f3.x, f3.y, { button: "right" });
    await page.getByRole("menuitem", { name: /Cherry-pick 3 commits onto target/ }).click();

    await page.getByLabel("Combine them into a single commit").check();
    const message = page.getByRole("textbox", { name: "Commit message" });
    assert.equal(await message.inputValue(), "f1\nf2\nf3", "the summaries make a starting message");
    await message.fill("Three features in one");
    await page.getByRole("button", { name: "Cherry-pick into one commit" }).click();
    await page.getByText("Cherry-picked into one commit").waitFor();

    assert.equal(git(repo, "log", "-2", "--format=%s").trim(), "Three features in one\nbase");
    for (const n of ["f1", "f2", "f3"]) assert.ok(existsSync(join(repo, `${n}.txt`)), n);
  });
});

describe("Perseus asking for a login", () => {
  let app;
  let page;
  let server;
  const seen = [];

  before(async () => {
    // A remote that demands HTTP Basic credentials, like a private repository does.
    server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (!auth) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="perseus-test"' }).end();
      } else {
        seen.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString());
        res.writeHead(404).end("not a real repository");
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const repo = join(scratchDir("perseus-auth-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "remote", "add", "origin", `http://127.0.0.1:${port}/private.git`);
    app = await launch({ recents: [{ path: repo, name: "repo" }], port: 9448 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
    await new Promise((r) => server?.close(r));
  });

  it("shows git's username and password questions and passes the answers to git", async () => {
    await page.locator(".recent-main", { hasText: "repo" }).click();
    await page.getByText(/1 commit/).waitFor();
    await page.getByRole("button", { name: "Fetch" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByText(/Username for/).waitFor({ timeout: 15000 });
    await dialog.locator("input").fill("ada");
    await dialog.getByRole("button", { name: "Continue" }).click();

    await dialog.getByText(/Password for/).waitFor({ timeout: 15000 });
    assert.equal(await dialog.locator("input").getAttribute("type"), "password", "secrets are hidden");
    await dialog.locator("input").fill("hunter2");
    await dialog.getByRole("button", { name: "Continue" }).click();

    await page.getByText("Fetch failed").waitFor({ timeout: 15000 });
    assert.ok(seen.includes("ada:hunter2"), `the server should have received the login, saw ${JSON.stringify(seen)}`);
  });

  it("lets the user cancel a prompt, and git then stops instead of hanging", async () => {
    seen.length = 0;
    await page.getByRole("button", { name: "Fetch" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/Username for/).waitFor({ timeout: 15000 });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByText("Fetch failed").first().waitFor({ timeout: 15000 });
    assert.deepEqual(seen, []);
  });
});

describe("Perseus with worktrees, submodules and big files", () => {
  let app;
  let page;
  let repo;

  before(async () => {
    const root = scratchDir("perseus-extras-");
    const lib = join(root, "lib");
    mkdirSync(lib, { recursive: true });
    git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, "l.txt"), "lib\n");
    git(lib, "add", "-A");
    git(lib, "commit", "-q", "-m", "lib first");

    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "branch", "side");
    git(repo, "worktree", "add", join(root, "side-tree"), "side");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    git(repo, "commit", "-q", "-m", "add submodule");

    app = await launch({ recents: [{ path: repo, name: "repo" }], port: 9449 });
    page = app.page;
  });

  after(async () => {
    await app?.stop();
  });

  it("lists linked worktrees and submodules in the sidebar", async () => {
    await page.locator(".recent-main", { hasText: "repo" }).click();
    await page.getByText(/2 commits/).waitFor();
    await page.getByRole("button", { name: /Worktrees/ }).waitFor();
    await page.getByRole("button", { name: /Submodules/ }).waitFor();
    await page.locator(".side-row", { hasText: "vendor/lib" }).waitFor();
  });

  it("opens a worktree as its own repository", async () => {
    await page.locator(".side-row", { hasText: "side" }).last().dblclick();
    await page.locator(".repo-tab", { hasText: "side-tree" }).waitFor({ timeout: 10000 });
  });

  it("warns about a large staged file, using the threshold from Settings", async () => {
    await page.locator(".repo-tab", { hasText: "repo" }).first().click();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Large file threshold in megabytes").fill("1");
    await page.getByRole("button", { name: "Exit Settings" }).click();
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    git(repo, "add", "big.bin");
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.getByText(/staged file is very large/).waitFor({ timeout: 10000 });
  });

  it("shows the git commands Perseus ran in the activity log", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Activity log" }).click();
    const log = page.getByLabel("Git commands");
    await log.getByText(/git .*worktree/).first().waitFor().catch(() => undefined);
    await page.getByLabel("Use extended logging (include commands that only read)").check();
    await log.getByText(/git (status|log|for-each-ref)/).first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Exit Settings" }).click();
  });

  it("changes what the graph shows from Settings and restores it", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "UI Customization" }).click();
    await page.getByLabel("Show commit author").uncheck();
    await page.getByRole("button", { name: "Exit Settings" }).click();
    assert.equal(await page.locator(".gh-cell", { hasText: "Author" }).count(), 0, "the Author column is gone");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "UI Customization" }).click();
    await page.getByLabel("Show commit author").check();
    await page.getByRole("button", { name: "Exit Settings" }).click();
    await page.locator(".gh-cell", { hasText: "Author" }).waitFor();
  });

  it("adds a submodule from a folder on this computer", async () => {
    const second = join(repo, "..", "second-lib");
    mkdirSync(second, { recursive: true });
    git(second, "init", "-q", "-b", "main");
    writeFileSync(join(second, "s.txt"), "second\n");
    git(second, "add", "-A");
    git(second, "commit", "-q", "-m", "second lib");
    // Unstage the earlier big file so only the submodule shows up as staged.
    git(repo, "reset", "-q");

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("add a submodule");
    await page.keyboard.press("Enter");
    await page.getByLabel("Repository address").fill(second);
    assert.equal(await page.getByLabel("Folder inside this repository").inputValue(), "second-lib", "named after the address");
    await page.getByRole("button", { name: "Add submodule" }).click();
    await page.getByText(/Submodule added/).waitFor({ timeout: 20000 });

    assert.deepEqual(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort(), [".gitmodules", "second-lib"]);
    await page.locator(".side-row", { hasText: "second-lib" }).waitFor();
  });
});
