// End-to-end tests against the production executable. Run `pnpm tauri build --no-bundle`
// first, then `pnpm e2e`. Windows only (WebView2 exposes the DevTools protocol).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("warns about a large staged file, using the threshold from Preferences", async () => {
    await page.locator(".repo-tab", { hasText: "repo" }).first().click();
    await page.getByRole("button", { name: "Preferences" }).click();
    await page.getByLabel("Large file threshold in megabytes").fill("1");
    await page.getByRole("button", { name: "Done" }).click();
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    git(repo, "add", "big.bin");
    await page.locator('[role="tab"]', { hasText: "Changes" }).click();
    await page.getByText(/staged file is very large/).waitFor({ timeout: 10000 });
  });

  it("shows the git commands Perseus ran in the activity log", async () => {
    await page.getByRole("button", { name: "Preferences" }).click();
    const log = page.getByLabel("Git commands");
    await log.getByText(/git .*worktree/).first().waitFor().catch(() => undefined);
    await page.getByLabel("Show read-only commands").check().catch(async () => {
      await page.getByText("Show read-only commands").click();
    });
    await log.getByText(/git (status|log|for-each-ref)/).first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Done" }).click();
  });
});
