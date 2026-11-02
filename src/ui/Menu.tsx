import {
  type ComponentType,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Shortcut } from "./bits";

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export type MenuItem =
  | {
      id: string;
      label: string;
      icon?: IconType;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Shows a check mark (radio-style choices such as the theme). */
      checked?: boolean;
      /** Small dimmed text after the label. */
      hint?: string;
    }
  | { id: string; separator: true }
  | { id: string; section: string };

const isAction = (i: MenuItem): i is Extract<MenuItem, { label: string }> => "label" in i;

interface MenuProps {
  /** Viewport coordinates of the anchor point. */
  x: number;
  y: number;
  items: MenuItem[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** Treat x as the menu's right edge (for menus opened from a button near the window edge). */
  alignRight?: boolean;
  minWidth?: number;
}

/** Popup menu used for context menus and dropdowns: arrow keys, Enter, Escape, click-away. */
export function Menu({ x, y, items, onPick, onClose, alignRight, minWidth = 200 }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = alignRight ? x - width : x;
    setPos({
      left: Math.max(6, Math.min(left, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
    });
    el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [x, y, alignRight]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      if (e.key === "ArrowDown") next = (at + 1) % buttons.length;
      else if (e.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = buttons.length - 1;
      else if (e.key === "Tab") {
        e.preventDefault();
        onClose();
        return;
      }
      if (next !== null) {
        e.preventDefault();
        buttons[next].focus();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ ...pos, minWidth }}>
      {items.map((item) => {
        if ("separator" in item) return <div key={item.id} className="menu-sep" role="separator" />;
        if ("section" in item)
          return (
            <div key={item.id} className="menu-section">
              {item.section}
            </div>
          );
        if (!isAction(item)) return null;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={item.danger ? "menu-item danger" : "menu-item"}
            onClick={() => onPick(item.id)}
          >
            <span className="menu-icon">
              {item.checked ? <Check size={14} /> : Icon && <Icon size={14} />}
            </span>
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
            {item.shortcut && <Shortcut keys={item.shortcut} />}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

interface MenuButtonProps {
  items: MenuItem[];
  onPick: (id: string) => void;
  align?: "start" | "end";
  minWidth?: number;
  /** Renders the trigger; spread `props` onto a button. */
  render: (props: {
    onClick: (e: React.MouseEvent<HTMLElement>) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    open: boolean;
  }) => ReactElement;
}

/** A trigger that opens a `Menu` right under itself. */
export function MenuButton({ items, onPick, align = "start", minWidth, render }: MenuButtonProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      {render({
        open: !!at,
        "aria-haspopup": "menu",
        "aria-expanded": !!at,
        onClick: (e) => {
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: align === "end" ? r.right : r.left, y: r.bottom + 6 });
        },
      })}
      {at && (
        <Menu
          x={at.x}
          y={at.y}
          items={items}
          alignRight={align === "end"}
          minWidth={minWidth}
          onClose={() => setAt(null)}
          onPick={(id) => {
            setAt(null);
            onPick(id);
          }}
        />
      )}
    </>
  );
}
