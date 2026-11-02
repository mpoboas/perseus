import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { clamp } from "../lib/prefs";

/** A titled block of settings, like "Date/Time" in GitKraken's UI Customization page. */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="set-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

interface RowProps {
  label: string;
  hint?: ReactNode;
  /** A caution shown under the hint, with a warning icon. */
  warn?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}

/** Label on the left, control on the right, explanation underneath. */
export function Row({ label, hint, warn, children, htmlFor }: RowProps) {
  return (
    <div className="set-row">
      <label className="set-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="set-control">
        {children}
        {hint && <p className="set-hint">{hint}</p>}
        {warn && (
          <p className="set-warn">
            <TriangleAlert size={13} /> {warn}
          </p>
        )}
      </div>
    </div>
  );
}

export function CheckRow({
  label,
  hint,
  warn,
  checked,
  disabled,
  onChange,
  text,
}: {
  label: string;
  hint?: ReactNode;
  warn?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  /** Text right of the box, when the label on the left needs a short companion. */
  text?: string;
}) {
  const id = `chk-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Row label={label} hint={hint} warn={warn} htmlFor={id}>
      <label className="set-check">
        <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {text && <span>{text}</span>}
      </label>
    </Row>
  );
}

export function NumberRow({
  label,
  hint,
  warn,
  value,
  min,
  max,
  suffix,
  ariaLabel,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  warn?: ReactNode;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  ariaLabel?: string;
  onChange: (v: number) => void;
}) {
  const id = `num-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Row label={label} hint={hint} warn={warn} htmlFor={id}>
      <div className="set-inline">
        <input
          id={id}
          className="input set-number"
          type="number"
          min={min}
          max={max}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(clamp(Math.floor(Number(e.target.value) || 0), min, max))}
        />
        {suffix && <span className="muted">{suffix}</span>}
      </div>
    </Row>
  );
}

export function TextRow({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = `txt-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className="input set-text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

export function SelectRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = `sel-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <select id={id} className="select set-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}
