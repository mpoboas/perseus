import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface Props {
  /** Small label above the name ("repository", "branch"). */
  caption: string;
  /** The current choice, shown large under the caption. */
  value: ReactNode;
  /** Extra markup after the name (ahead/behind counts). */
  extra?: ReactNode;
  ariaLabel: string;
  tooltip?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
  width?: number;
  /** The list under the search box. Items are `.pk-item` buttons so the arrow keys find them. */
  children: (ctx: { query: string; close: () => void }) => ReactNode;
}

/** A name with a caption that opens a searchable list, modelled on GitKraken's repository and branch pickers. */
export function Picker({ caption, value, extra, ariaLabel, tooltip, disabled, placeholder = "Search", width = 280, children }: Props) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const trigger = (
    <button
      ref={triggerRef}
      className={anchor ? "pk-trigger open" : "pk-trigger"}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={!!anchor}
      disabled={disabled}
      onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
    >
      <span className="pk-text">
        <span className="pk-caption">{caption}</span>
        <span className="pk-value">{value}</span>
      </span>
      {extra}
      <ChevronDown size={13} className="pk-chevron" />
    </button>
  );

  return (
    <>
      {tooltip && !anchor ? <Tooltip label={tooltip}>{trigger}</Tooltip> : trigger}
      {anchor && (
        <Popover anchor={anchor} width={width} placeholder={placeholder} triggerRef={triggerRef} onClose={() => setAnchor(null)}>
          {children}
        </Popover>
      )}
    </>
  );
}

interface PopoverProps {
  anchor: DOMRect;
  width: number;
  placeholder: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: Props["children"];
}

function Popover({ anchor, width, placeholder, triggerRef, onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [left, setLeft] = useState(anchor.left);
  const w = Math.max(width, anchor.width);

  useLayoutEffect(() => {
    setLeft(Math.max(6, Math.min(anchor.left, window.innerWidth - w - 6)));
    input.current?.focus();
    ref.current?.querySelector(".pk-item.current")?.scrollIntoView({ block: "nearest" });
  }, [anchor, w]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      // The trigger toggles on its own click; closing here too would reopen the list straight away.
      if (!ref.current?.contains(t) && !triggerRef.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, triggerRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const box = input.current;
    if (!box || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(".pk-item:not(:disabled)")];
    const stops = [box, ...items];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      stops[Math.min(at + 1, stops.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      stops[Math.max(at - 1, 0)]?.focus();
    } else if (e.key === "Enter" && document.activeElement === box) {
      e.preventDefault();
      items[0]?.click();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== box) {
      // Typing while an entry has focus goes to the search box.
      box.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="pk-pop"
      style={{ left, top: anchor.bottom + 6, width: w }}
      onKeyDown={onKeyDown}
    >
      <label className="pk-search">
        <Search size={15} />
        <input
          ref={input}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="pk-body" style={{ maxHeight: Math.max(160, Math.min(380, window.innerHeight - anchor.bottom - 130)) }}>
        {children({ query: query.trim(), close: onClose })}
      </div>
    </div>,
    document.body,
  );
}
