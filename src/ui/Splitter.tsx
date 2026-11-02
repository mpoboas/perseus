import { useRef } from "react";
import { clamp } from "../lib/prefs";

interface Props {
  /** "vertical" is a vertical bar that resizes widths; "horizontal" resizes heights. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Double-click restores this size. */
  reset?: number;
  /** Dragging toward the start (left/up) grows the panel (handle sits on the panel's far edge). */
  invert?: boolean;
  label: string;
}

const KEY_STEP = 16;

/** Drag handle between two panes. Pointer-captured, keyboard operable, double-click resets. */
export function Splitter({ orientation, value, min, max, onChange, reset, invert, label }: Props) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const vertical = orientation === "vertical";
  const sign = invert ? -1 : 1;

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: vertical ? e.clientX : e.clientY, value };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const delta = ((vertical ? e.clientX : e.clientY) - s.pos) * sign;
        onChange(clamp(s.value + delta, min, max));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => reset !== undefined && onChange(reset)}
      onKeyDown={(e) => {
        const grow = vertical ? (invert ? "ArrowLeft" : "ArrowRight") : invert ? "ArrowUp" : "ArrowDown";
        const shrink = vertical ? (invert ? "ArrowRight" : "ArrowLeft") : invert ? "ArrowDown" : "ArrowUp";
        if (e.key === grow) onChange(clamp(value + KEY_STEP, min, max));
        else if (e.key === shrink) onChange(clamp(value - KEY_STEP, min, max));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}
