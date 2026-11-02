import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, CheckCircle2, Copy, Info, X } from "lucide-react";
import { IconButton } from "./Button";

type Kind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
}

interface ToastApi {
  info: (title: string, detail?: string) => void;
  success: (title: string, detail?: string) => void;
  /** Errors stay until dismissed; they carry the raw message so it can be copied. */
  error: (title: string, detail?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const ICONS = { info: Info, success: CheckCircle2, error: AlertTriangle } as const;
const LIFETIME_MS: Record<Kind, number> = { info: 3500, success: 3500, error: 0 };
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);

  const push = useCallback((kind: Kind, title: string, detail?: string) => {
    const id = next.current++;
    setItems((l) => {
      // A repeat of the toast already showing just stays; it does not stack up.
      if (l.some((t) => t.kind === kind && t.title === title && t.detail === detail)) return l;
      return [...l, { id, kind, title, detail }].slice(-MAX_VISIBLE);
    });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      info: (t, d) => push("info", t, d),
      success: (t, d) => push("success", t, d),
      error: (t, d) => push("error", t, d),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = ICONS[item.kind];
  const life = LIFETIME_MS[item.kind];
  useEffect(() => {
    if (!life) return;
    const t = window.setTimeout(onDismiss, life);
    return () => window.clearTimeout(t);
  }, [life, onDismiss]);

  const copy = () => void navigator.clipboard?.writeText(item.detail ?? item.title).catch(() => undefined);

  return (
    <div className={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
      <Icon size={16} className="toast-icon" />
      <div className="toast-text">
        <strong>{item.title}</strong>
        {item.detail && <p className="selectable">{item.detail}</p>}
      </div>
      {item.kind === "error" && <IconButton icon={Copy} label="Copy error" size="sm" onClick={copy} />}
      <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} />
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
