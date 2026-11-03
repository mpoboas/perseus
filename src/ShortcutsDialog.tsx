import { FIXED_SHORTCUTS, SHORTCUTS, useBindings } from "./lib/shortcuts";
import { Button, Dialog, Shortcut } from "./ui";

const GROUPS = ["General", "View", "Graph", "Changes"] as const;

export function ShortcutsDialog({ onClose, onCustomize }: { onClose: () => void; onCustomize: () => void }) {
  const bindings = useBindings();
  return (
    <Dialog
      title="Keyboard shortcuts"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onCustomize}>Customize…</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="dialog-body shortcuts-grid">
        {GROUPS.map((g) => {
          const own = SHORTCUTS.filter((s) => s.group === g);
          const fixed = FIXED_SHORTCUTS.filter((s) => s.group === g);
          if (own.length + fixed.length === 0) return null;
          return (
            <section key={g}>
              <h3>{g}</h3>
              <dl>
                {own.map((s) => (
                  <div key={s.id} className="shortcut-row">
                    <dt>{s.label}</dt>
                    <dd>
                      {bindings[s.id].length === 0 ? (
                        <span className="muted">Not assigned</span>
                      ) : (
                        bindings[s.id].slice(0, 2).map((b) => <Shortcut key={b} keys={b} />)
                      )}
                    </dd>
                  </div>
                ))}
                {fixed.map((s) => (
                  <div key={s.label} className="shortcut-row">
                    <dt>{s.label}</dt>
                    <dd>
                      <span className="muted">{s.keys}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
