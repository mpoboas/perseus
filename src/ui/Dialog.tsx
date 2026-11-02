import { type ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width in px. */
  width?: number;
  /** Render as a form so Enter submits. */
  onSubmit?: () => void;
  /** Lets a caller keep the backdrop from dismissing (e.g. mid-operation). */
  dismissible?: boolean;
  /** Anchor the dialog near the top (command palette style) instead of the middle. */
  top?: boolean;
  bare?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: closes on Escape and backdrop click, keeps Tab inside, and hands focus
 * back to whatever opened it.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520,
  onSubmit,
  dismissible = true,
  top,
  bare,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Prefer an explicit autofocus target; otherwise the first field, then the first button.
    const target =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>("input, textarea, select") ??
      el?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [dismissible]);

  const Body = onSubmit ? "form" : "div";
  return (
    <div
      className={top ? "scrim scrim-top" : "scrim"}
      onMouseDown={(e) => dismissible && e.target === e.currentTarget && onClose()}
    >
      <Body
        ref={ref as never}
        className={bare ? "dialog dialog-bare" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: width }}
        {...(onSubmit
          ? {
              onSubmit: (e: React.FormEvent) => {
                e.preventDefault();
                onSubmit();
              },
            }
          : {})}
      >
        <header className={bare ? "sr-only" : "dialog-head"}>
          <h2 id={titleId}>{title}</h2>
          {!bare && dismissible && <IconButton icon={X} label="Close" size="sm" onClick={onClose} type="button" />}
        </header>
        {children}
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </Body>
    </div>
  );
}
