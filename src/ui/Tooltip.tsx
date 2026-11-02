import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Shortcut } from "./bits";

interface Props {
  label: ReactNode;
  /** e.g. "Ctrl+K", shown as key caps next to the label. */
  shortcut?: string;
  side?: "top" | "bottom";
  children: ReactElement<Record<string, unknown>>;
}

const DELAY_MS = 450;

/** A real tooltip (keyboard-focus aware) instead of the browser's slow, unstyled `title`. */
export function Tooltip({ label, shortcut, side = "bottom", children }: Props) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef(0);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setAt(null);
  }, []);

  const show = useCallback(
    (el: Element, delay: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setAt({ x: r.left + r.width / 2, y: side === "bottom" ? r.bottom + 8 : r.top - 8 });
      }, delay);
    },
    [side],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const child = children;
  const merged = cloneElement(child, {
    onPointerEnter: (e: React.PointerEvent) => {
      (child.props.onPointerEnter as ((e: React.PointerEvent) => void) | undefined)?.(e);
      show(e.currentTarget, DELAY_MS);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      (child.props.onPointerLeave as ((e: React.PointerEvent) => void) | undefined)?.(e);
      hide();
    },
    onPointerDown: (e: React.PointerEvent) => {
      (child.props.onPointerDown as ((e: React.PointerEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      (child.props.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget, 150);
    },
    onBlur: (e: React.FocusEvent) => {
      (child.props.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      hide();
    },
  });

  return (
    <>
      {merged}
      {at &&
        createPortal(
          <div
            role="tooltip"
            className={`tooltip tooltip-${side}`}
            style={{ left: at.x, top: at.y }}
          >
            <span>{label}</span>
            {shortcut && <Shortcut keys={shortcut} />}
          </div>,
          document.body,
        )}
    </>
  );
}
