import { type ComponentType, type ReactNode, forwardRef } from "react";
import { Spinner } from "./bits";
import { Tooltip } from "./Tooltip";

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: IconType;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : Icon && <Icon size={size === "sm" ? 13 : 15} />}
      {children && <span>{children}</span>}
    </button>
  );
});

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconType;
  /** Doubles as the accessible name and the tooltip text. */
  label: string;
  shortcut?: string;
  size?: "sm" | "md";
  active?: boolean;
  tooltipSide?: "top" | "bottom";
  badge?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, shortcut, size = "md", active, tooltipSide, badge, className, ...rest },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={`icon-btn icon-btn-${size}${active ? " active" : ""}${className ? ` ${className}` : ""}`}
        {...rest}
      >
        <Icon size={size === "sm" ? 14 : 16} />
        {badge}
      </button>
    </Tooltip>
  );
});
