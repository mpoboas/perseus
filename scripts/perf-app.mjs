// Drives a running Perseus (started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>)
// through the DevTools protocol: opens a repository from the recents list, waits for the history to
// load, then scrolls the whole graph while recording frame times.
//
//   node scripts/perf-app.mjs <port> <repoName> [seconds=6]
//
// Prints JSON: load time, frame-time percentiles while scrolling, dropped frames, JS heap.
const [port, repoName, secondsArg] = process.argv.slice(2);
if (!port || !repoName) {
  console.error("usage: node scripts/perf-app.mjs <port> <repoName> [seconds]");
  process.exit(2);
}
const seconds = Number(secondsArg ?? 6);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

// Open the repository from the welcome screen's recents (they load asynchronously).
let opened = false;
for (let i = 0; i < 100 && !opened; i++) {
  opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.recent-main')].find((b) => b.textContent.includes(${JSON.stringify(repoName)}));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  if (!opened) await new Promise((r) => setTimeout(r, 200));
}
if (!opened) {
  console.error(`no usable recent repository named ${repoName}`);
  process.exit(1);
}

const t0 = Date.now();
let loadedText = "";
let firstRowMs = null;
for (;;) {
  const state = await evaluate(`({
    status: document.querySelector('.statusbar')?.innerText ?? '',
    scrollH: document.querySelector('.graph-scroller')?.scrollHeight ?? 0,
  })`);
  if (firstRowMs === null && state.scrollH > 700) firstRowMs = Date.now() - t0;
  if (/commits · /.test(state.status)) {
    loadedText = state.status;
    break;
  }
  if (Date.now() - t0 > 300_000) throw new Error("history did not finish loading");
  await new Promise((r) => setTimeout(r, 100));
}
const loadMs = Date.now() - t0;

const result = await evaluate(`new Promise((resolve) => {
  const sc = document.querySelector('.graph-scroller');
  const max = sc.scrollHeight - sc.clientHeight;
  const frames = [];
  let last = performance.now();
  const start = last;
  const perFrame = Math.max(64, Math.round(max / (${seconds} * 60)));
  let dir = 1;
  function tick(now) {
    frames.push(now - last);
    last = now;
    sc.scrollTop = Math.min(max, Math.max(0, sc.scrollTop + dir * perFrame));
    if (sc.scrollTop >= max) dir = -1;
    if (sc.scrollTop <= 0) dir = 1;
    if (now - start < ${seconds} * 1000) requestAnimationFrame(tick);
    else {
      frames.shift();
      const s = [...frames].sort((a, b) => a - b);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      resolve({
        rows: Math.round(max / 32),
        scrolledPxPerFrame: perFrame,
        frames: frames.length,
        avgFps: +(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)).toFixed(1),
        p50ms: +q(0.5).toFixed(1),
        p95ms: +q(0.95).toFixed(1),
        p99ms: +q(0.99).toFixed(1),
        maxMs: +s[s.length - 1].toFixed(1),
        droppedOver20ms: frames.filter((f) => f > 20).length,
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      });
    }
  }
  requestAnimationFrame(tick);
})`);

console.log(JSON.stringify({ repo: repoName, firstRowsMs: firstRowMs, loadMs, status: loadedText.replace(/\s+/g, " "), scroll: result }, null, 2));
ws.close();
process.exit(0);
