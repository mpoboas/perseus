import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommitStore } from "./commitStore";

export const ROW_H = 26;
const LANE_W = 14;
const PAD = 10;
const MAX_GRAPH_LANES = 16;
const NODE_R = 4;
const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

const color = (c: number) => PALETTE[c % PALETTE.length];
const laneX = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;

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

function relativeDate(seconds: number, now: number): string {
  const d = now / 1000 - seconds;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

interface Props {
  store: CommitStore;
  /** Row count; changing it tells the canvas that new rows have arrived. */
  count: number;
  selected: number | null;
  onSelect: (row: number) => void;
  /** Scrolls the given row into the middle of the view whenever `nonce` changes. */
  reveal: { row: number; nonce: number } | null;
}

export function GraphCanvas({ store, count, selected, onSelect, reveal }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 800, h: 600 });
  const [viewH, setViewH] = useState(600);
  const raf = useRef(0);
  const latest = useRef({ count, selected });
  latest.current = { count, selected };

  const draw = useCallback(() => {
    raf.current = 0;
    const cv = canvas.current;
    const sc = scroller.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !sc || !ctx) return;

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

    const { count: n, selected: sel } = latest.current;
    const top = sc.scrollTop;
    const first = Math.floor(top / ROW_H);
    const last = Math.min(n - 1, Math.ceil((top + h) / ROW_H));
    const graphW = PAD * 2 + Math.min(store.maxLanes, MAX_GRAPH_LANES) * LANE_W;
    const text = getComputedStyle(cv).color;
    const bg = getComputedStyle(document.body).backgroundColor;
    const now = Date.now();

    // Pass 1: selection highlight.
    if (sel !== null && sel >= first && sel <= last) {
      ctx.fillStyle = "rgba(90, 140, 255, 0.22)";
      ctx.fillRect(0, sel * ROW_H - top, w, ROW_H);
    }

    // Pass 2: edges and nodes, clipped to the graph column.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, graphW, h);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let r = first; r <= last; r++) {
      const row = store.rows[r];
      if (!row) break;
      const g = row.graph;
      const y = r * ROW_H - top;
      const cy = y + ROW_H / 2;
      const nx = laneX(g.lane);

      for (const [lane, c] of g.through) {
        ctx.strokeStyle = color(c);
        line(ctx, laneX(lane), y, laneX(lane), y + ROW_H);
      }
      for (const [lane, c] of g.incoming) {
        ctx.strokeStyle = color(c);
        line(ctx, laneX(lane), y, nx, cy);
      }
      for (const [lane, c] of g.outgoing) {
        ctx.strokeStyle = color(c);
        line(ctx, nx, cy, laneX(lane), y + ROW_H);
      }

      ctx.beginPath();
      ctx.arc(nx, cy, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = color(g.color);
      ctx.fill();
      if (row.parents.length > 1) {
        // Merge commits get a hollow center.
        ctx.beginPath();
        ctx.arc(nx, cy, NODE_R - 2, 0, Math.PI * 2);
        ctx.fillStyle = bg;
        ctx.fill();
      }
    }
    ctx.restore();

    // Pass 3: text. Right-aligned columns first so the summary can fill what remains.
    ctx.font = "13px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const dateW = 80;
    const authorW = 130;
    const summaryRight = w - dateW - authorW - 12;
    for (let r = first; r <= last; r++) {
      const row = store.rows[r];
      if (!row) break;
      const cy = r * ROW_H - top + ROW_H / 2;

      ctx.globalAlpha = 0.6;
      ctx.fillStyle = text;
      ctx.textAlign = "right";
      ctx.fillText(relativeDate(row.time, now), w - 10, cy);
      ctx.textAlign = "left";
      ctx.save();
      ctx.beginPath();
      ctx.rect(w - dateW - authorW, cy - ROW_H / 2, authorW - 8, ROW_H);
      ctx.clip();
      ctx.fillText(row.author, w - dateW - authorW, cy);
      ctx.restore();
      ctx.globalAlpha = 1;

      let x = graphW + 6;
      for (const ref of row.refs) {
        const tw = ctx.measureText(ref).width;
        ctx.fillStyle = ref === "HEAD" ? "#2f7d32" : "#3b5ea8";
        ctx.beginPath();
        ctx.roundRect(x, cy - 9, tw + 10, 18, 9);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(ref, x + 5, cy);
        x += tw + 16;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, cy - ROW_H / 2, Math.max(0, summaryRight - x), ROW_H);
      ctx.clip();
      ctx.fillStyle = text;
      ctx.fillText(row.summary, x, cy);
      ctx.restore();
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

  useEffect(schedule, [count, selected, schedule]);

  // Keep the selected row visible (keyboard navigation).
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || selected === null) return;
    const y = selected * ROW_H;
    if (y < sc.scrollTop) sc.scrollTop = y;
    else if (y + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + ROW_H - sc.clientHeight;
  }, [selected]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !reveal) return;
    sc.scrollTop = Math.max(0, reveal.row * ROW_H - sc.clientHeight / 2);
  }, [reveal]);

  const onClick = (e: React.MouseEvent) => {
    const sc = scroller.current;
    if (!sc) return;
    const y = e.clientY - sc.getBoundingClientRect().top + sc.scrollTop;
    const row = Math.floor(y / ROW_H);
    if (row >= 0 && row < count) onSelect(row);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (count === 0) return;
    const page = Math.max(1, Math.floor(size.current.h / ROW_H) - 1);
    const cur = selected ?? -1;
    const next =
      e.key === "ArrowDown" ? cur + 1
      : e.key === "ArrowUp" ? cur - 1
      : e.key === "PageDown" ? cur + page
      : e.key === "PageUp" ? cur - page
      : e.key === "Home" ? 0
      : e.key === "End" ? count - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    onSelect(Math.min(count - 1, Math.max(0, next)));
  };

  return (
    <div
      ref={scroller}
      className="graph-scroller"
      tabIndex={0}
      onScroll={schedule}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} className="graph-canvas" />
      {/* Total scroll height = canvas height (sticky) + this spacer. */}
      <div style={{ height: Math.max(0, count * ROW_H - viewH) }} />
    </div>
  );
}
