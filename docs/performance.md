# Performance

Numbers measured on the production build (`pnpm tauri build --no-bundle`), Windows 11, a 150 Hz
display, synthetic repositories from `scripts/make-perf-repo.mjs` (a long `main` with a side branch
merged back every 40 commits, six authors). Reproduce with:

```
node scripts/make-perf-repo.mjs <dir> 50000
node scripts/perf-run.mjs <dir>              # app: load time, scroll frame times, memory
cargo run --release -p perseus --example walk_timing -- <dir>   # backend walk only
```

## Results

| Repository | Commits ready (app) | Scroll, whole history | p99 frame | Dropped frames (>20 ms) | App + WebView2 memory |
|---|---|---|---|---|---|
| 10,000 commits | 0.3 s | 149 fps | 7.6 ms | 4 of ~900 | 556 MB |
| 50,000 commits | 1.1 s (includes writing the commit-graph file) | 152 fps | 7.6 ms | 0 | 1.2 GB |
| 500,000 commits | 5.5 s | 131 fps | 8.4 ms | 2 of ~900 | 1.5 GB |

The scroll test moves the scroll position by a fixed distance on every animation frame, from top to
bottom and back for six seconds, and records the time between frames. 150 fps is this display's
refresh rate, so the graph keeps up with the monitor; the 60 FPS goal from the original plan is met
with a wide margin on 500,000 rows.

## What made the difference

* **Commit-graph file.** Without one, git (and `gix`) must open every commit object to learn its
  parents. Backend walk of 500,000 commits: **72 s without the file, 4 s with it** (50,000: 7 s vs
  0.4 s). Perseus now writes one (`git commit-graph write --reachable`) the first time it streams a
  repository that lacks it. It is a cache that git itself writes during `gc`; writing it takes
  about 5 s at 500,000 commits and 0.1 s at 10,000.
* **Streaming in chunks of 500 rows** with the canvas drawing only visible rows, so rendering cost
  does not depend on history length.
* **Rows live outside React state**, so a chunk arriving does not re-render the application.

## Budgets (regressions to avoid)

| Measure | Budget |
|---|---|
| Rows visible after opening, 50,000 commits | under 1.5 s |
| Rows visible after opening, 500,000 commits | under 8 s |
| 99th percentile frame time while scrolling | under 16 ms |
| JS heap at 500,000 commits | under 400 MB (269 MB today) |

## Known limits

* **The scroll extent is capped at 8 million pixels.** A row is 28 px, so up to about 285,000 rows scroll
  one-to-one. Beyond that (Chromium itself stops at about 33 million pixels, other engines earlier) the
  scroll bar is stretched: one real pixel stands for several list pixels (`lib/scrollMap.ts`), the wheel
  moves by rows, and the end of the bar is the end of the history. Tested end to end with 320,000 commits
  (`End` reaches the oldest commit). Above a few million rows one real pixel is more than a row, so the
  scroll bar alone can no longer address every row; the keyboard, search and jump-to-commit still do.
* **Memory is dominated by WebView2**, not by the history: at 50,000 commits the JS heap is 53 MB
  while the whole process tree is 1.2 GB. The renderer reserved memory for a very tall scroll surface;
  the capped extent should lower that, but it has not been re-measured.
* The first 1.4 s of a 500,000-commit load is the topological sort inside `gix`, before the first
  chunk can be produced.

## A bug these measurements found

Every earlier test used repositories of a handful of commits. With real history the page showed an
empty graph in the production build: chunks larger than 8 KiB are delivered by Tauri through the
internal command `plugin:__TAURI_CHANNEL__|fetch`, which the isolation hook was blocking. The
command is now allowed explicitly (and a test pins that it is the only exception), and the E2E
suite opens a 1,200-commit repository so this cannot regress unnoticed.
