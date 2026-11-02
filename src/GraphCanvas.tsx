import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cloud, GitCommitVertical, Laptop } from "lucide-react";
import type { CommitStore } from "./commitStore";
import {
  type Badge,
  ROW_H,
  type Subject,
  isDrag,
  rowAt,
  sameSubject,
  subjectAt,
} from "./graphLayout";
import type { RefInfo } from "./ipc";
import { absoluteTime, avatarColor, initials, relativeTime } from "./lib/format";
import { avatarImage, ownerImage, subscribeAvatars } from "./lib/avatars";
import { Avatar, EmptyState, Skeleton, Splitter } from "./ui";

const LANE_W = 22;
const PAD = 12;
const MAX_GRAPH_LANES = 12;
/** Merge commits are small solid dots; every other commit is an avatar disc. */
const NODE_R = 5.5;
const AVATAR_R = 10;
const CHIP_H = 18;
const AVATAR_D = 18;
/** Gap kept between the ref column's text and its edge. */
const REF_PAD = 8;
const ICON = 12;
/** Space above and below each row's colour band. */
const BAND_GAP = 3;

// Icon outlines from the lucide set (24x24), painted straight onto the canvas.
const PATH_LAPTOP = new Path2D(
  "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16",
);
const PATH_CLOUD = new Path2D("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z");
const PATH_CHECK = new Path2D("M20 6 9 17l-5-5");

function icon(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, color: string) {
  const k = ICON / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  ctx.stroke(path);
  ctx.restore();
}

/** `#rrggbb` plus an alpha as an `rgba()` string (the lane tokens are plain hex). */
function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
const TOOLTIP_DELAY_MS = 450;
const EDGE_SCROLL_ZONE = 28;
const EDGE_SCROLL_STEP = 14;
const LANE_COUNT = 10;

/** Colors the canvas needs, read from the CSS tokens so the graph follows the theme. */
interface Palette {
  lanes: string[];
  bg: string;
  text: string;
  dim: string;
  faint: string;
  border: string;
  accent: string;
  hover: string;
  selected: string;
  wip: string;
  head: string;
  branch: string;
  remote: string;
  tag: string;
  onChip: string;
  add: string;
  del: string;
  font: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    lanes: Array.from({ length: LANE_COUNT }, (_, i) => v(`--lane-${i}`)),
    bg: v("--surface-1"),
    text: v("--text"),
    dim: v("--text-dim"),
    faint: v("--text-faint"),
    border: v("--border"),
    accent: v("--accent"),
    hover: v("--graph-hover"),
    selected: v("--graph-selected"),
    wip: v("--graph-wip"),
    head: v("--ref-head"),
    branch: v("--ref-branch"),
    remote: v("--ref-remote"),
    tag: v("--ref-tag"),
    onChip: v("--ref-text-on"),
    add: v("--st-add"),
    del: v("--st-del"),
    font: v("--font-ui"),
  };
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (x0 === x1) {
    ctx.lineTo(x1, y1);
  } else {
    const my = (y0 + y1) / 2;
    ctx.bezierCurveTo(x0, my, x1, my, x1, y1);
  }
  ctx.stroke();
}

export interface WipSummary {
  files: number;
  additions: number;
  deletions: number;
}

interface Props {
  store: CommitStore;
  /** Row count; changing it tells the canvas that new rows have arrived. */
  count: number;
  loading: boolean;
  selected: number | "wip" | null;
  onSelect: (row: number) => void;
  onSelectWip: () => void;
  /** Scrolls the given commit row into the middle of the view whenever `nonce` changes. */
  reveal: { row: number; nonce: number } | null;
  /** A chip or commit was dragged onto another. */
  onDrop: (source: Subject, target: Subject) => void;
  /** Right-click (viewport coordinates). */
  onMenu: (subject: Subject, x: number, y: number) => void;
  /** Short text for the drag ghost. */
  labelFor: (s: Subject) => string;
  /** Uncommitted changes, drawn as a row above the first commit. */
  wip: WipSummary | null;
  /** Row of the commit HEAD points at, so the working-tree row can connect to it. */
  headRow: number | null;
  headBranch: string | null;
  refKinds: ReadonlyMap<string, RefInfo["kind"]>;
  refsW: number;
  authorW: number;
  dateW: number;
  /** "absolute" shows 07/10/2026 @ 14:37, "relative" shows 26d ago. */
  dateStyle: "absolute" | "relative";
  onResizeRefs: (w: number) => void;
  onResizeAuthor: (w: number) => void;
  onResizeDate: (w: number) => void;
}

interface DragState {
  source: Subject;
  x: number;
  y: number;
  target: Subject | null;
}

interface Tip {
  row: number;
  x: number;
  y: number;
  /** Over the branch/tag column: list the row's refs instead of the commit. */
  refs: boolean;
}

export function GraphCanvas({
  store,
  count,
  loading,
  selected,
  onSelect,
  onSelectWip,
  reveal,
  onDrop,
  onMenu,
  labelFor,
  wip,
  headRow,
  headBranch,
  refKinds,
  refsW,
  authorW,
  dateW,
  dateStyle,
  onResizeRefs,
  onResizeAuthor,
  onResizeDate,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 800, h: 600 });
  const [viewH, setViewH] = useState(600);
  const [scrollbarW, setScrollbarW] = useState(0);
  const [graphW, setGraphW] = useState(PAD * 2 + LANE_W);
  const raf = useRef(0);
  const palette = useRef<Palette | null>(null);
  const hover = useRef<number | null>(null);

  const offset = wip ? 1 : 0;
  // Everything the draw loop needs, kept in a ref so `draw` stays stable between renders.
  const latest = useRef({ count, selected, wip, headRow, headBranch, refKinds, refsW, authorW, dateW, dateStyle, offset });
  latest.current = { count, selected, wip, headRow, headBranch, refKinds, refsW, authorW, dateW, dateStyle, offset };

  /** Where each visible commit's ref chips were painted, for hit-testing. */
  const badges = useRef(new Map<number, Badge[]>());
  const press = useRef<{ x: number; y: number; subject: Subject; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipTimer = useRef(0);
  const tipKey = useRef<string | null>(null);

  const draw = useCallback(() => {
    raf.current = 0;
    const cv = canvas.current;
    const sc = scroller.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !sc || !ctx) return;
    const pal = (palette.current ??= readPalette());
    const lane = (c: number) => pal.lanes[c % LANE_COUNT];

    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    badges.current.clear();

    const { count: n, selected: sel, wip: wipInfo, headRow: headIdx, headBranch: headName, refKinds: kinds, offset: off } =
      latest.current;
    const authW = latest.current.authorW;
    const datW = latest.current.dateW;
    const base = latest.current.refsW;
    const absolute = latest.current.dateStyle === "absolute";
    const laneX = (ln: number) => base + PAD + ln * LANE_W + LANE_W / 2;
    const top = sc.scrollTop;
    const total = n + off;
    const firstDisplay = Math.max(0, Math.floor(top / ROW_H));
    const lastDisplay = Math.min(total - 1, Math.ceil((top + h) / ROW_H));
    const gW = PAD * 2 + Math.min(store.maxLanes, MAX_GRAPH_LANES) * LANE_W;
    const now = Date.now();
    const yOf = (display: number) => display * ROW_H - top;

    // Pass 0: each commit gets a band in its branch colour that starts at its avatar and ends where
    // the message begins, with a small gap above and below so neighbouring rows stay separate.
    for (let d = Math.max(firstDisplay, off); d <= lastDisplay; d++) {
      const row = store.rows[d - off];
      if (!row) break;
      const x0 = laneX(row.graph.lane);
      const x1 = base + gW;
      if (x1 <= x0) continue;
      ctx.fillStyle = rgba(lane(row.graph.color), 0.3);
      ctx.fillRect(x0, yOf(d) + BAND_GAP, x1 - x0, ROW_H - BAND_GAP * 2);
    }

    // Pass 1: row backgrounds (hover and selection).
    const selDisplay = sel === "wip" ? 0 : sel === null ? null : sel + off;
    for (let d = firstDisplay; d <= lastDisplay; d++) {
      if (d === selDisplay) {
        ctx.fillStyle = pal.selected;
        ctx.fillRect(0, yOf(d), w, ROW_H);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(0, yOf(d), 2, ROW_H);
      } else if (d === hover.current) {
        ctx.fillStyle = pal.hover;
        ctx.fillRect(0, yOf(d), w, ROW_H);
      }
    }

    // Column dividers.
    const authorX = w - datW - authW;
    ctx.fillStyle = pal.border;
    ctx.fillRect(Math.round(base) - 0.5, 0, 1, h);
    ctx.fillRect(Math.round(authorX) - 0.5, 0, 1, h);
    ctx.fillRect(Math.round(w - datW) - 0.5, 0, 1, h);

    // Where each visible row's ref chips sit in the left column; drawn in pass 3, but the
    // connector from the last chip to the node is part of the graph and is drawn here.
    ctx.font = `600 11px ${pal.font}`;
    const chipLayouts = new Map<number, ChipLayout>();
    for (let d = Math.max(firstDisplay, off); d <= lastDisplay; d++) {
      const row = store.rows[d - off];
      if (!row || row.refs.length === 0) continue;
      chipLayouts.set(d, layoutChips(ctx, chipsFor(row.refs, headName, kinds), base - REF_PAD * 2));
    }

    // Hovering a commit that carries no label shows (faded) the branch it belongs to.
    const hoverDisplay = hover.current;
    if (hoverDisplay !== null && hoverDisplay >= off && !chipLayouts.has(hoverDisplay)) {
      const ghost = ghostChip(store, hoverDisplay - off, headName, kinds);
      if (ghost) chipLayouts.set(hoverDisplay, { ...layoutChips(ctx, [ghost], base - REF_PAD * 2), ghost: true });
    }

    // Pass 2: edges and nodes, clipped to the refs and graph columns.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, base + gW, h);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";

    // The working-tree row hangs off HEAD's lane with a dashed connector.
    if (wipInfo && firstDisplay === 0) {
      const headLane = headIdx !== null ? (store.rows[headIdx]?.graph.lane ?? 0) : 0;
      const x = laneX(headLane);
      const cy = yOf(0) + ROW_H / 2;
      const toY = headIdx !== null ? yOf(headIdx + off) + ROW_H / 2 : cy + ROW_H;
      ctx.strokeStyle = pal.wip;
      ctx.setLineDash([3, 4]);
      ctx.lineCap = "butt";
      line(ctx, x, cy, x, Math.min(toY, h + ROW_H));
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(x, cy, AVATAR_R - 1, 0, Math.PI * 2);
      ctx.fillStyle = pal.bg;
      ctx.fill();
      ctx.setLineDash([2.5, 2.5]);
      ctx.lineWidth = 1.75;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
    }

    for (let d = Math.max(firstDisplay, off); d <= lastDisplay; d++) {
      const r = d - off;
      const row = store.rows[r];
      if (!row) break;
      const g = row.graph;
      const y = yOf(d);
      const cy = y + ROW_H / 2;
      const nx = laneX(g.lane);

      for (const [ln, c] of g.through) {
        ctx.strokeStyle = lane(c);
        line(ctx, laneX(ln), y, laneX(ln), y + ROW_H);
      }
      for (const [ln, c] of g.incoming) {
        ctx.strokeStyle = lane(c);
        line(ctx, laneX(ln), y, nx, cy);
      }
      for (const [ln, c] of g.outgoing) {
        ctx.strokeStyle = lane(c);
        line(ctx, nx, cy, laneX(ln), y + ROW_H);
      }

      // A line from the ref chips to the node ties the label to its commit.
      const layout = chipLayouts.get(d);
      if (layout && layout.items.length > 0) {
        ctx.strokeStyle = lane(g.color);
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        line(ctx, REF_PAD + layout.end + 3, cy, nx, cy);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
      }

      const merge = row.parents.length > 1;
      const radius = merge ? NODE_R : AVATAR_R;
      const isHead = r === headIdx;
      if (isHead) {
        ctx.beginPath();
        ctx.arc(nx, cy, radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = pal.head;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 2;
      }
      // A background-colored halo separates the node from the lines running through it.
      ctx.beginPath();
      ctx.arc(nx, cy, radius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = pal.bg;
      ctx.fill();
      if (merge) {
        ctx.beginPath();
        ctx.arc(nx, cy, NODE_R + 0.5, 0, Math.PI * 2);
        ctx.fillStyle = lane(g.color);
        ctx.fill();
      } else {
        const picture = avatarImage(row.author_email, row.oid);
        ctx.beginPath();
        ctx.arc(nx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = avatarColor(row.author);
        ctx.fill();
        if (picture) {
          ctx.save();
          ctx.clip();
          ctx.drawImage(picture, nx - radius, cy - radius, radius * 2, radius * 2);
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(nx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = lane(g.color);
        ctx.lineWidth = 2;
        ctx.stroke();
        if (!picture) {
          ctx.font = `700 8px ${pal.font}`;
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(initials(row.author), nx, cy + 0.5);
        }
      }
    }
    ctx.restore();

    // Pass 3: text columns. Right-aligned ones first so the message can fill what remains.
    ctx.textBaseline = "middle";
    const messageRight = authorX - 10;
    const messageLeft = base + gW + 6;
    const clipped = (x: number, width: number, d: number, fn: () => void) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, yOf(d), Math.max(0, width), ROW_H);
      ctx.clip();
      fn();
      ctx.restore();
    };

    for (let d = firstDisplay; d <= lastDisplay; d++) {
      const cy = yOf(d) + ROW_H / 2;

      if (d < off && wipInfo) {
        ctx.font = `600 13px ${pal.font}`;
        ctx.textAlign = "left";
        ctx.fillStyle = pal.text;
        const label = "Working tree";
        ctx.fillText(label, messageLeft, cy);
        let x = messageLeft + ctx.measureText(label).width + 10;
        ctx.font = `12px ${pal.font}`;
        ctx.fillStyle = pal.dim;
        const files = `${wipInfo.files} changed file${wipInfo.files === 1 ? "" : "s"}`;
        ctx.fillText(files, x, cy);
        x += ctx.measureText(files).width + 10;
        if (wipInfo.additions > 0) {
          const t = `+${wipInfo.additions}`;
          ctx.fillStyle = pal.add;
          ctx.fillText(t, x, cy);
          x += ctx.measureText(t).width + 6;
        }
        if (wipInfo.deletions > 0) {
          ctx.fillStyle = pal.del;
          ctx.fillText(`−${wipInfo.deletions}`, x, cy);
        }
        continue;
      }

      const r = d - off;
      const row = store.rows[r];
      if (!row) break;

      // Date
      ctx.font = `12px ${pal.font}`;
      ctx.fillStyle = pal.faint;
      ctx.textAlign = "right";
      const stamp = absolute ? absoluteTime(row.time) : relativeTime(row.time, now);
      clipped(w - datW, datW, d, () => ctx.fillText(stamp, w - 12, cy));

      // Author: avatar + name
      ctx.textAlign = "left";
      const authorPicture = avatarImage(row.author_email, row.oid);
      ctx.beginPath();
      ctx.arc(authorX + 12 + AVATAR_D / 2, cy, AVATAR_D / 2, 0, Math.PI * 2);
      ctx.fillStyle = avatarColor(row.author);
      ctx.fill();
      if (authorPicture) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(authorPicture, authorX + 12, cy - AVATAR_D / 2, AVATAR_D, AVATAR_D);
        ctx.restore();
      } else {
        ctx.font = `700 9px ${pal.font}`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(initials(row.author), authorX + 12 + AVATAR_D / 2, cy + 0.5);
      }
      ctx.textAlign = "left";
      ctx.font = `12px ${pal.font}`;
      ctx.fillStyle = pal.dim;
      const nameX = authorX + 12 + AVATAR_D + 7;
      clipped(nameX, w - datW - nameX - 6, d, () => ctx.fillText(row.author, nameX, cy));

      // Ref chips live in their own column on the left.
      const layout = chipLayouts.get(d);
      const rowBadges: Badge[] = [];
      if (layout) {
        ctx.font = `600 11px ${pal.font}`;
        const laneColor = lane(row.graph.color);
        if (layout.ghost) ctx.globalAlpha = 0.5;
        for (const it of layout.items) {
          const x = REF_PAD + it.x;
          const head = it.chip.kind === "head";
          const tag = it.chip.kind === "tag";
          const accent = tag ? pal.tag : laneColor;
          ctx.beginPath();
          ctx.roundRect(x, cy - CHIP_H / 2, it.w, CHIP_H, 5);
          let ink: string;
          if (head) {
            ctx.fillStyle = pal.head;
            ctx.fill();
            ink = pal.onChip;
          } else {
            ctx.fillStyle = rgba(accent, 0.24);
            ctx.fill();
            ctx.strokeStyle = rgba(accent, 0.7);
            ctx.lineWidth = 1;
            ctx.stroke();
            ink = pal.text;
          }
          let tx = x + 6;
          if (head) {
            icon(ctx, PATH_CHECK, tx, cy - ICON / 2, ink);
            tx += ICON + 3;
          }
          ctx.fillStyle = ink;
          ctx.textAlign = "left";
          ctx.fillText(it.label, tx, cy + 0.5);
          tx += ctx.measureText(it.label).width + 5;
          // A laptop means the branch exists on this computer; a cloud, on a remote.
          if (it.chip.local) {
            icon(ctx, PATH_LAPTOP, tx, cy - ICON / 2, ink);
            tx += ICON + 3;
          }
          if (it.chip.remotes.length > 0) {
            const owner = ownerImage();
            if (owner) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(tx + ICON / 2, cy, ICON / 2, 0, Math.PI * 2);
              ctx.clip();
              ctx.drawImage(owner, tx, cy - ICON / 2, ICON, ICON);
              ctx.restore();
            } else {
              icon(ctx, PATH_CLOUD, tx, cy - ICON / 2, ink);
            }
          }
          if (!layout.ghost) rowBadges.push({ ref: it.chip.ref, x, w: it.w });
        }
        ctx.globalAlpha = 1;
        if (layout.more > 0) {
          ctx.fillStyle = pal.faint;
          ctx.textAlign = "left";
          ctx.fillText(`+${layout.more}`, REF_PAD + layout.end + 6, cy + 0.5);
        }
      }
      if (rowBadges.length) badges.current.set(r, rowBadges);

      ctx.font = `${d === selDisplay ? "700 " : ""}13px ${pal.font}`;
      ctx.fillStyle = d === selDisplay || row.parents.length <= 1 ? pal.text : pal.dim;
      ctx.textAlign = "left";
      clipped(messageLeft, messageRight - messageLeft, d, () => ctx.fillText(row.summary, messageLeft, cy));
    }
  }, [store]);

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const measure = () => {
      size.current = { w: sc.clientWidth, h: sc.clientHeight };
      setViewH(sc.clientHeight);
      setScrollbarW(sc.offsetWidth - sc.clientWidth);
      if (canvas.current) {
        canvas.current.style.width = `${sc.clientWidth}px`;
        canvas.current.style.height = `${sc.clientHeight}px`;
      }
      schedule();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [schedule]);

  // The canvas paints its own colors, so a theme change must re-read the tokens.
  useEffect(() => {
    const onTheme = () => {
      palette.current = null;
      schedule();
    };
    window.addEventListener("perseus-theme", onTheme);
    return () => window.removeEventListener("perseus-theme", onTheme);
  }, [schedule]);

  useEffect(() => {
    setGraphW(PAD * 2 + Math.min(store.maxLanes, MAX_GRAPH_LANES) * LANE_W);
  }, [count, store]);

  useEffect(schedule, [count, selected, wip, headRow, headBranch, refKinds, refsW, authorW, dateW, dateStyle, schedule]);

  // Keep the selected row visible (keyboard navigation).
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || selected === null) return;
    const display = selected === "wip" ? 0 : selected + offset;
    const y = display * ROW_H;
    if (y < sc.scrollTop) sc.scrollTop = y;
    else if (y + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + ROW_H - sc.clientHeight;
  }, [selected, offset]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !reveal) return;
    sc.scrollTop = Math.max(0, (reveal.row + offset) * ROW_H - sc.clientHeight / 2);
    // Only a new reveal request should scroll, not a change in the WIP offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  useEffect(() => subscribeAvatars(schedule), [schedule]);

  /** Pointer position relative to the scroller's visible area. */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = scroller.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const subjectUnder = (x: number, y: number) =>
    subjectAt(x, y, scroller.current?.scrollTop ?? 0, latest.current.count, badges.current, latest.current.offset);

  const hideTip = () => {
    window.clearTimeout(tipTimer.current);
    tipKey.current = null;
    setTip(null);
  };

  const endDrag = () => {
    press.current = null;
    dragRef.current = null;
    setDrag(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    if (x > size.current.w) return; // the scrollbar
    const subject = subjectUnder(x, y);
    if (!subject) return;
    hideTip();
    press.current = { x, y, subject, pointerId: e.pointerId };
  };

  const setHover = (display: number | null) => {
    if (hover.current === display) return;
    hover.current = display;
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const p = press.current;
    const top = scroller.current?.scrollTop ?? 0;

    if (p && !dragRef.current && p.subject.kind !== "wip" && isDrag(x - p.x, y - p.y)) {
      scroller.current?.setPointerCapture(p.pointerId);
      dragRef.current = { source: p.subject, x, y, target: null };
    }

    if (dragRef.current) {
      const sc = scroller.current!;
      // Scroll while hovering near the top or bottom edge, so far-away targets are reachable.
      if (y < EDGE_SCROLL_ZONE) sc.scrollTop -= EDGE_SCROLL_STEP;
      else if (y > size.current.h - EDGE_SCROLL_ZONE) sc.scrollTop += EDGE_SCROLL_STEP;

      const found = subjectUnder(x, y);
      const target = sameSubject(found, dragRef.current.source) ? null : found;
      dragRef.current = { ...dragRef.current, x, y, target };
      setDrag(dragRef.current);
      return;
    }

    const display = rowAt(y, top, latest.current.count + latest.current.offset);
    setHover(x <= size.current.w ? display : null);

    // Plain hover: show a tooltip once the pointer rests on a commit row.
    const row = display === null || display < latest.current.offset ? null : display - latest.current.offset;
    const inRefs = x < latest.current.refsW;
    const key = row === null ? null : `${row}:${inRefs}`;
    if (key !== tipKey.current) {
      hideTip();
      tipKey.current = key;
      if (row !== null && x <= size.current.w) {
        tipTimer.current = window.setTimeout(() => setTip({ row, x, y, refs: inRefs }), TOOLTIP_DELAY_MS);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    const d = dragRef.current;
    if (d) {
      if (scroller.current?.hasPointerCapture(e.pointerId)) {
        scroller.current.releasePointerCapture(e.pointerId);
      }
      endDrag();
      if (d.target) onDrop(d.source, d.target);
      return;
    }
    press.current = null;
    if (!p) return;
    if (p.subject.kind === "wip") onSelectWip();
    else onSelect(p.subject.row); // a press without movement is a click
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = local(e);
    const subject = subjectUnder(x, y);
    if (!subject) return;
    hideTip();
    if (subject.kind === "wip") onSelectWip();
    else onSelect(subject.row);
    onMenu(subject, e.clientX, e.clientY);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && dragRef.current) {
      endDrag();
      return;
    }
    if (count === 0) return;
    const page = Math.max(1, Math.floor(size.current.h / ROW_H) - 1);
    // Navigate in display rows so the working-tree row takes part like any other.
    const cur = selected === "wip" ? 0 : selected === null ? -1 : selected + offset;
    const last = count + offset - 1;
    const next =
      e.key === "ArrowDown" ? cur + 1
      : e.key === "ArrowUp" ? cur - 1
      : e.key === "PageDown" ? cur + page
      : e.key === "PageUp" ? cur - page
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const display = Math.min(last, Math.max(0, next));
    if (display < offset) onSelectWip();
    else onSelect(display - offset);
  };

  const top = scroller.current?.scrollTop ?? 0;
  const targetBox = (() => {
    const t = drag?.target;
    if (!t || t.kind === "wip") return null;
    const y = (t.row + offset) * ROW_H - top;
    if (t.kind === "ref") {
      const b = badges.current.get(t.row)?.find((x) => x.ref === t.name);
      if (b) return { left: b.x - 2, top: y + 4, width: b.w + 4, height: ROW_H - 8 };
    }
    return { left: 0, top: y, width: size.current.w, height: ROW_H };
  })();
  const tipRowData = tip ? store.rows[tip.row] : undefined;
  const tipChips = tip?.refs && tipRowData ? chipsFor(tipRowData.refs, headBranch, refKinds) : [];
  const showSkeleton = loading && count === 0;

  return (
    <div className="graph-wrap">
      <div className="graph-header" style={{ paddingRight: scrollbarW }}>
        <div className="gh-cell gh-refs" style={{ width: refsW }}>
          Branch / tag
          <Splitter
            orientation="vertical"
            label="Resize branch and tag column"
            value={refsW}
            min={120}
            max={420}
            reset={190}
            onChange={onResizeRefs}
          />
        </div>
        <div className="gh-cell" style={{ width: graphW }}>
          Graph
        </div>
        <div className="gh-cell gh-grow">Message</div>
        <div className="gh-cell gh-resizable" style={{ width: authorW }}>
          <Splitter
            orientation="vertical"
            label="Resize author column"
            value={authorW}
            min={90}
            max={320}
            reset={170}
            invert
            onChange={onResizeAuthor}
          />
          Author
        </div>
        <div className="gh-cell gh-resizable" style={{ width: dateW }}>
          <Splitter
            orientation="vertical"
            label="Resize date column"
            value={dateW}
            min={64}
            max={240}
            reset={150}
            invert
            onChange={onResizeDate}
          />
          Date / time
        </div>
      </div>

      <div className="graph-body">
        <div
          ref={scroller}
          className={drag ? "graph-scroller dragging" : "graph-scroller"}
          tabIndex={0}
          role="listbox"
          aria-label="Commit history"
          onScroll={() => {
            hideTip();
            schedule();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            hideTip();
            setHover(null);
          }}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        >
          <canvas ref={canvas} className="graph-canvas" />
          {/* Total scroll height = canvas height (sticky) + this spacer. */}
          <div style={{ height: Math.max(0, (count + offset) * ROW_H - viewH) }} />
        </div>

        {showSkeleton && (
          <div className="graph-skeleton" aria-label="Loading commits">
            {Array.from({ length: 14 }, (_, i) => (
              <div key={i} className="gs-row">
                <Skeleton width={10} height={10} />
                <Skeleton width={`${30 + ((i * 37) % 45)}%`} height={10} />
              </div>
            ))}
          </div>
        )}
        {!loading && count === 0 && (
          <EmptyState icon={GitCommitVertical} title="No commits yet" hint="Make your first commit from the Changes tab." />
        )}

        {/* Interactive feedback lives in the DOM, above the canvas, and never takes pointer events. */}
        <div className="graph-overlay" aria-hidden="true">
          {targetBox && <div className="drop-target" style={targetBox} />}
          {drag && (
            <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
              {labelFor(drag.source)}
            </div>
          )}
          {tip && tipRowData && !drag && tip.refs && tipChips.length > 0 && (
            <div
              className="graph-tooltip refs-tip"
              style={{
                left: Math.min(tip.x + 14, Math.max(0, size.current.w - 340)),
                top: Math.min(tip.y + 18, Math.max(0, size.current.h - 40 - tipChips.length * 44)),
              }}
            >
              {tipChips.map((c) => (
                <div key={c.ref} className="rt-row">
                  <strong>{c.label}</strong>
                  <span className="rt-where">
                    {c.local && (
                      <span>
                        <Laptop size={12} /> on this computer
                      </span>
                    )}
                    {c.remotes.map((r) => (
                      <span key={r}>
                        <Cloud size={12} /> {r}
                      </span>
                    ))}
                    {c.kind === "tag" && <span>tag</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {tip && tipRowData && !drag && !tip.refs && (
            <div
              className="graph-tooltip"
              style={{
                left: Math.min(tip.x + 14, Math.max(0, size.current.w - 360)),
                top: Math.min(tip.y + 18, Math.max(0, size.current.h - 120)),
              }}
            >
              <div className="gt-author">
                <Avatar name={tipRowData.author} email={tipRowData.author_email} sha={tipRowData.oid} size={22} />
                <div>
                  <strong>{tipRowData.author}</strong>
                  <span>{new Date(tipRowData.time * 1000).toLocaleString()}</span>
                </div>
              </div>
              <p className="gt-summary">{tipRowData.summary}</p>
              <div className="gt-meta">
                <code>{tipRowData.oid.slice(0, 10)}</code>
                {tipRowData.parents.length > 1 && <span>Merge of {tipRowData.parents.length} parents</span>}
                {tipRowData.parents.length === 0 && <span>Root commit</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Chip {
  /** The ref name this chip stands for (what drag and drop acts on): the local branch if there is one. */
  ref: string;
  label: string;
  kind: "head" | "branch" | "remote" | "tag";
  /** The branch exists on this computer. */
  local: boolean;
  /** Remotes that have a branch of this name (`origin`). */
  remotes: string[];
}

/**
 * One chip per branch name: a local branch and its remote copies (`main`, `origin/main`) share a
 * chip that shows a laptop and/or a cloud. The checked-out branch absorbs the separate "HEAD"
 * token and is drawn green; a detached HEAD keeps its own chip. `origin/HEAD` is noise and is
 * dropped. Order: checked out, local, remote-only, tags.
 */
function chipsFor(
  refs: readonly string[],
  headBranch: string | null,
  kinds: ReadonlyMap<string, RefInfo["kind"]>,
): Chip[] {
  const byName = new Map<string, Chip>();
  const out: Chip[] = [];
  const hasHeadBranch = headBranch !== null && refs.includes(headBranch);
  for (const ref of refs) {
    if (ref === "HEAD") {
      if (!hasHeadBranch) out.push({ ref, label: "HEAD", kind: "head", local: false, remotes: [] });
      continue;
    }
    const kind = kinds.get(ref) ?? "branch";
    if (kind === "tag") {
      out.push({ ref, label: ref, kind: "tag", local: false, remotes: [] });
      continue;
    }
    const slash = ref.indexOf("/");
    const isRemote = kind === "remote" && slash > 0;
    const name = isRemote ? ref.slice(slash + 1) : ref;
    if (isRemote && name === "HEAD") continue;
    let chip = byName.get(name);
    if (!chip) {
      chip = { ref, label: name, kind: "remote", local: false, remotes: [] };
      byName.set(name, chip);
      out.push(chip);
    }
    if (isRemote) {
      chip.remotes.push(ref.slice(0, slash));
    } else {
      chip.local = true;
      chip.ref = ref;
      chip.kind = ref === headBranch ? "head" : "branch";
    }
  }
  const rank = { head: 0, branch: 1, remote: 2, tag: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * The branch a commit without a label of its own belongs to: the nearest labelled commit above it
 * (newer) drawn in the same branch colour. Only a guess for display, shown faded.
 */
function ghostChip(
  store: CommitStore,
  r: number,
  headBranch: string | null,
  kinds: ReadonlyMap<string, RefInfo["kind"]>,
): Chip | null {
  const row = store.rows[r];
  if (!row || row.refs.length > 0) return null;
  const color = row.graph.color;
  for (let i = r - 1; i >= Math.max(0, r - 4000); i--) {
    const above = store.rows[i];
    if (!above || above.graph.color !== color || above.refs.length === 0) continue;
    const chip = chipsFor(above.refs, headBranch, kinds).find((c) => c.kind !== "tag" && c.label !== "HEAD");
    if (chip) return { ...chip, kind: "branch" };
  }
  return null;
}

interface ChipLayout {
  items: { chip: Chip; x: number; w: number; label: string }[];
  /** Hidden chips that did not fit. */
  more: number;
  /** Right edge of the last chip (relative to the column's padding). */
  end: number;
  /** A guess shown while hovering an unlabelled commit. */
  ghost?: boolean;
}

/** Width a chip needs besides its label: padding, the check mark, and one icon per place it lives. */
const chipExtras = (c: Chip) =>
  12 + (c.kind === "head" ? ICON + 3 : 0) + (c.local ? ICON + 3 : 0) + (c.remotes.length > 0 ? ICON + 3 : 0) + (c.local || c.remotes.length ? 2 : 0);

/**
 * Lays chips out left to right inside `maxW`. The first chip is always shown, shortened with an
 * ellipsis if it alone is too wide; the rest are dropped into a "+N" count.
 */
function layoutChips(ctx: CanvasRenderingContext2D, chips: Chip[], maxW: number): ChipLayout {
  const items: ChipLayout["items"] = [];
  let x = 0;
  const reserve = 26;
  for (const chip of chips) {
    let label = chip.label;
    const extras = chipExtras(chip);
    let w = ctx.measureText(label).width + extras;
    const limit = maxW - (chips.length > 1 ? reserve : 0);
    if (items.length === 0 && w > limit) {
      const room = Math.max(24, limit) - extras;
      while (label.length > 1 && ctx.measureText(`${label}…`).width > room) label = label.slice(0, -1);
      label = `${label}…`;
      w = ctx.measureText(label).width + extras;
    }
    const more = chips.length - items.length - 1;
    if (items.length > 0 && x + w > maxW - (more > 0 ? reserve : 0)) break;
    items.push({ chip, x, w, label });
    x += w + 4;
  }
  const last = items[items.length - 1];
  return { items, more: chips.length - items.length, end: last ? last.x + last.w : 0 };
}
