// Measures the production executable on large repositories.
//
//   node scripts/perf-run.mjs <repo-dir> [<repo-dir> ...]
//
// For each repository: starts the app with an isolated app-data folder whose recents list holds
// just that repository, opens it, waits for the history, scrolls the whole graph recording frame
// times (scripts/perf-app.mjs), then reports the memory of the app and its WebView2 processes.
// Generate repositories with scripts/make-perf-repo.mjs.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const exe = process.env.PERSEUS_EXE ?? resolve("target/release/perseus.exe");
const port = 9555;
const repos = process.argv.slice(2);
if (repos.length === 0) {
  console.error("usage: node scripts/perf-run.mjs <repo-dir> [...]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Working set (MB) of the app plus every process it started (the WebView2 helpers). */
function treeMemoryMB(pid) {
  const script = `
    $all = Get-CimInstance Win32_Process
    $ids = @(${pid}); $grew = $true
    while ($grew) { $grew = $false
      foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId; $grew = $true } } }
    $sum = 0; foreach ($i in $ids) { $pr = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($pr) { $sum += $pr.WorkingSet64 } }
    [math]::Round($sum / 1MB)`;
  return Number(execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim());
}

for (const repo of repos) {
  const root = mkdtempSync(join(tmpdir(), "perseus-perf-"));
  const dataDir = join(root, "appdata", "dev.perseus.app");
  mkdirSync(dataDir, { recursive: true });
  const name = basename(repo);
  writeFileSync(
    join(dataDir, "recents.json"),
    JSON.stringify([{ path: resolve(repo), name, last_opened: Math.floor(Date.now() / 1000) }]),
  );
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      PERSEUS_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json`);
        break;
      } catch {
        await sleep(200);
      }
    }
    await sleep(1500);
    const out = execFileSync("node", ["scripts/perf-app.mjs", String(port), name], { encoding: "utf8", maxBuffer: 1 << 24 });
    const result = JSON.parse(out);
    result.memoryMB = treeMemoryMB(child.pid);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    child.kill();
    await sleep(800);
    rmSync(root, { recursive: true, force: true });
  }
}
