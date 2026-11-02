import { type ComponentType, type ReactNode, forwardRef, useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { avatarUrl, subscribeAvatars } from "../lib/avatars";
import { avatarColor, initials } from "../lib/format";
import { Tooltip } from "./Tooltip";

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden="true" />;
}

export function Skeleton({ width, height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width: width ?? "100%", height }} aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** "Ctrl+Shift+K" → individual key caps. */
export function Shortcut({ keys }: { keys: string }) {
  return (
    <span className="shortcut" aria-label={keys}>
      {keys.split("+").map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "warn" | "danger";

export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Initials on a color derived from the name, so every person is recognizable at a glance. */
export function Avatar({ name, size = 24, email }: { name: string; size?: number; email?: string }) {
  const [, redraw] = useState(0);
  useEffect(() => subscribeAvatars(() => redraw((n) => n + 1)), []);
  const picture = avatarUrl(email);
  if (picture) {
    return <img className="avatar avatar-img" alt="" aria-hidden="true" src={picture} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        background: avatarColor(name),
      }}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon?: IconType;
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={28} strokeWidth={1.5} />}
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconType;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  iconOnly = false,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  label: string;
  iconOnly?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const Icon = o.icon;
        const button = (
          <button
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            aria-label={iconOnly ? o.label : undefined}
            className={o.value === value ? "seg active" : "seg"}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon size={14} />}
            {!iconOnly && <span>{o.label}</span>}
          </button>
        );
        return iconOnly ? (
          <Tooltip key={o.value} label={o.label}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; icon?: IconType }
>(function TextField({ label, hint, icon: Icon, className, ...rest }, ref) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={Icon ? "input-wrap has-icon" : "input-wrap"}>
        {Icon && <Icon size={14} />}
        <input id={id} ref={ref} className={className ? `input ${className}` : "input"} {...rest} />
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
});
