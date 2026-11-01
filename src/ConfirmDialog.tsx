import { useEffect, useState } from "react";
import type { GraphAction } from "./actions";

interface Props {
  /** One or more things the gesture could mean; with several, the user picks. */
  actions: GraphAction[];
  /** Uncommitted tracked changes exist, which git may refuse to carry across the operation. */
  dirty: boolean;
  onConfirm: (action: GraphAction, name: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog({ actions, dirty, onConfirm, onCancel }: Props) {
  const [chosen, setChosen] = useState(actions[0].id);
  const [name, setName] = useState("");
  const action = actions.find((a) => a.id === chosen) ?? actions[0];
  const ready = !action.needsName || name.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => ready && onConfirm(action, name.trim());

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal confirm"
        role="dialog"
        aria-modal="true"
        aria-label={action.title}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="modal-head">
          <h2>{actions.length > 1 ? "Choose an action" : action.title}</h2>
        </header>
        <div className="confirm-body">
          {actions.length > 1 &&
            actions.map((a) => (
              <label key={a.id} className="choice">
                <input type="radio" checked={a.id === chosen} onChange={() => setChosen(a.id)} />
                <span>{a.title}</span>
              </label>
            ))}
          <p>{action.description}</p>
          {action.warning && <p className="warn-box">{action.warning}</p>}
          {dirty && !action.needsName && (
            <p className="muted">
              You have uncommitted changes. Git may refuse the operation, or stop with conflicts.
            </p>
          )}
          {action.needsName && (
            <label className="field">
              <span>Branch name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="feature/my-change"
              />
            </label>
          )}
        </div>
        <footer className="confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={action.danger ? "danger" : "primary"} disabled={!ready} autoFocus={!action.needsName}>
            {action.confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
