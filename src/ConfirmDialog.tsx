import { useEffect, useState } from "react";
import { CheckCircle2, Info, TriangleAlert } from "lucide-react";
import type { GraphAction } from "./actions";
import type { Prediction } from "./ipc";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** One or more things the gesture could mean; with several, the user picks. */
  actions: GraphAction[];
  /** Uncommitted tracked changes exist, which git may refuse to carry across the operation. */
  dirty: boolean;
  onConfirm: (action: GraphAction, name: string) => void;
  onCancel: () => void;
  /** Asks git which files would conflict, for merge, rebase and cherry-pick. */
  predict?: (action: GraphAction) => Promise<Prediction | null>;
}

export function ConfirmDialog({ actions, dirty, onConfirm, onCancel, predict }: Props) {
  const [chosen, setChosen] = useState(actions[0].id);
  const [name, setName] = useState(actions[0].nameInitial ?? "");
  const action = actions.find((a) => a.id === chosen) ?? actions[0];
  const ready = !action.needsName || name.trim().length > 0;
  const [forecast, setForecast] = useState<"checking" | Prediction | null>(null);

  // Preview the outcome without changing anything, so the user sees conflicts before agreeing.
  useEffect(() => {
    if (!predict) return;
    let live = true;
    setForecast("checking");
    predict(action).then(
      (p) => live && setForecast(p),
      () => live && setForecast(null),
    );
    return () => {
      live = false;
    };
  }, [predict, action]);

  return (
    <Dialog
      title={actions.length > 1 ? "Choose an action" : action.title}
      width={500}
      onClose={onCancel}
      onSubmit={() => ready && onConfirm(action, name.trim())}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={action.danger ? "danger" : "primary"}
            disabled={!ready}
            data-autofocus={!action.needsName ? "" : undefined}
          >
            {action.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        {actions.length > 1 && (
          <div className="choices" role="radiogroup" aria-label="Action">
            {actions.map((a) => (
              <label key={a.id} className={a.id === chosen ? "choice active" : "choice"}>
                <input type="radio" name="action" checked={a.id === chosen} onChange={() => setChosen(a.id)} />
                <span>{a.title}</span>
              </label>
            ))}
          </div>
        )}
        <p className="lede">{action.description}</p>
        {forecast === "checking" && <p className="muted small">Checking for conflicts…</p>}
        {forecast && forecast !== "checking" && forecast.supported && (
          forecast.conflicts.length === 0 ? (
            <div className="callout" role="note">
              <CheckCircle2 size={16} />
              <p>No conflicts expected.</p>
            </div>
          ) : (
            <div className="callout callout-warn" role="note">
              <TriangleAlert size={16} />
              <div>
                <p>
                  {forecast.conflicts.length} file{forecast.conflicts.length === 1 ? "" : "s"} would conflict. You can
                  resolve them afterwards or abort.
                </p>
                <ul className="conflict-names">
                  {forecast.conflicts.slice(0, 8).map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                  {forecast.conflicts.length > 8 && <li>and {forecast.conflicts.length - 8} more</li>}
                </ul>
              </div>
            </div>
          )
        )}
        {action.warning && (
          <div className="callout callout-warn" role="note">
            <TriangleAlert size={16} />
            <p>{action.warning}</p>
          </div>
        )}
        {dirty && !action.needsName && (
          <div className="callout" role="note">
            <Info size={16} />
            <p>You have uncommitted changes. Git may refuse the operation, or stop with conflicts.</p>
          </div>
        )}
        {action.needsName && (
          <TextField
            label={action.nameLabel ?? "Branch name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={action.namePlaceholder ?? "feature/my-change"}
          />
        )}
      </div>
    </Dialog>
  );
}
