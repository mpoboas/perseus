// Shared helpers for the end-to-end tests: build a fixture repository, start the production
// executable with an isolated app-data directory, and attach Playwright to its WebView2 over
// the DevTools protocol. Nothing here touches the user's real profiles or recents.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

export const EXE = process.env.PERSEUS_EXE ?? resolve("target/release/perseus.exe");

export function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** main: a, b, merge of topic (t1); a tag. */
export function makeFixture(root) {
  const dir = join(root, "fixture");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const commit = (name, body = name) => {
    writeFileSync(join(dir, `${name}.txt`), `${body}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `Add ${name}`);
  };
  commit("a");
  git(dir, "switch", "-q", "-c", "topic");
  commit("t1");
  git(dir, "switch", "-q", "main");
  commit("b");
  git(dir, "merge", "-q", "--no-ff", "-m", "Merge topic", "topic");
  git(dir, "tag", "v1");
  return dir;
}

export function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Starts the app and returns `{ page, root, consoleErrors, stop }`. */
export async function launch({ recents = [], port = 9444 } = {}) {
  const root = scratchDir("perseus-e2e-");
  const appdata = join(root, "appdata");
  mkdirSync(join(appdata, "dev.perseus.app"), { recursive: true });
  writeFileSync(
    join(appdata, "dev.perseus.app", "recents.json"),
    JSON.stringify(recents.map((r) => ({ ...r, last_opened: Math.floor(Date.now() / 1000) }))),
  );

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      PERSEUS_DATA_DIR: join(appdata, "dev.perseus.app"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });

  let browser;
  for (let i = 0; i < 100 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browser) {
    child.kill();
    throw new Error("could not attach to the app's WebView2");
  }
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost"));
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw new Error("the app window did not appear");

  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  return {
    page,
    root,
    consoleErrors,
    async stop() {
      await browser.close().catch(() => undefined);
      child.kill();
      // The WebView2 processes outlive the app for a moment and share one user-data folder:
      // wait until the debug port is gone before the next launch can start.
      for (let i = 0; i < 50; i++) {
        const alive = await fetch(`http://127.0.0.1:${port}/json`).then(() => true, () => false);
        if (!alive) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 500));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Center of display row `i` of the graph (row 0 is the working-tree row when `wip` is set). */
export async function rowPoint(page, i) {
  const box = await page.locator(".graph-scroller").boundingBox();
  const ROW_H = 28;
  return { x: box.x + 400, y: box.y + i * ROW_H + ROW_H / 2 };
}
