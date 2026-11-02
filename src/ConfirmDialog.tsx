import { useState } from "react";
import { Info, TriangleAlert } from "lucide-react";
import type { GraphAction } from "./actions";
import { Button, Dialog, TextField } from "./ui";

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
            label="Branch name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="feature/my-change"
          />
        )}
      </div>
    </Dialog>
  );
}
