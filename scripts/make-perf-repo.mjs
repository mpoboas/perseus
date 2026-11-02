// Generates a synthetic repository with `git fast-import`, for performance measurements.
//
//   node scripts/make-perf-repo.mjs <dir> <commits> [branchEvery=40] [branchLen=6]
//
// History shape: a long `main` line; every `branchEvery` commits a short side branch forks off
// and is merged back with a merge commit, so the graph has a realistic mix of lanes and merges.
// Commit times and authors vary so the author and date columns have something to draw.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";

const [dir, commitsArg, everyArg, lenArg] = process.argv.slice(2);
if (!dir || !commitsArg) {
  console.error("usage: node scripts/make-perf-repo.mjs <dir> <commits> [branchEvery] [branchLen]");
  process.exit(2);
}
const total = Number(commitsArg);
const branchEvery = Number(everyArg ?? 40);
const branchLen = Number(lenArg ?? 6);

mkdirSync(dir, { recursive: true });
if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${dir} is not empty`);
  process.exit(2);
}
execFileSync("git", ["init", "-q", "-b", "main", dir]);

const authors = ["Ada Lovelace", "Grace Hopper", "Linus T", "Margaret H", "Dennis R", "Barbara L"];
const out = [];
let mark = 0;
let t = 1_600_000_000;
let n = 0;

function commit(ref, parentMark, mergeMark, message) {
  const m = ++mark;
  const a = authors[n % authors.length];
  t += 37 + (n % 11) * 60;
  n++;
  out.push(`commit ${ref}\nmark :${m}\n`);
  out.push(`author ${a} <${a.split(" ")[0].toLowerCase()}@example.com> ${t} +0000\n`);
  out.push(`committer ${a} <${a.split(" ")[0].toLowerCase()}@example.com> ${t} +0000\n`);
  const body = Buffer.from(message);
  out.push(`data ${body.length}\n${message}\n`);
  if (parentMark) out.push(`from :${parentMark}\n`);
  if (mergeMark) out.push(`merge :${mergeMark}\n`);
  // One small file per commit keeps trees realistic without making the import slow.
  const content = `file ${n}\n`;
  out.push(`M 100644 inline src/f${n % 200}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  return m;
}

let mainTip = null;
let sideCount = 0;
while (n < total) {
  mainTip = commit("refs/heads/main", mainTip, null, `Commit ${n + 1} on main`);
  if (n % branchEvery === 0 && n + branchLen + 2 < total) {
    const ref = `refs/heads/feature/s${++sideCount}`;
    let tip = mainTip;
    for (let i = 0; i < branchLen; i++) tip = commit(ref, tip, null, `Work ${i + 1} on s${sideCount}`);
    mainTip = commit("refs/heads/main", mainTip, tip, `Merge feature/s${sideCount}`);
  }
}
out.push("done\n");

const p = spawn("git", ["-C", dir, "fast-import", "--quiet", "--done"], { stdio: ["pipe", "inherit", "inherit"] });
p.stdin.write(out.join(""));
p.stdin.end();
p.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  execFileSync("git", ["-C", dir, "reset", "-q", "--hard", "main"]);
  const count = execFileSync("git", ["-C", dir, "rev-list", "--count", "--all"]).toString().trim();
  console.log(`created ${dir}: ${count} commits, ${sideCount} side branches`);
});
