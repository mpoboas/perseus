import { Button, Dialog, Shortcut } from "./ui";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "General",
    rows: [
      ["Command palette", "Ctrl+K"],
      ["Open repository", "Ctrl+O"],
      ["Toggle sidebar", "Ctrl+B"],
      ["Refresh", "F5"],
      ["Undo / redo the last action", "Ctrl+Z / Ctrl+Shift+Z"],
      ["Keyboard shortcuts", "?"],
    ],
  },
  {
    title: "Graph",
    rows: [
      ["Move between commits", "↑ / ↓"],
      ["Page up / down", "PgUp / PgDn"],
      ["First / last commit", "Home / End"],
      ["Context menu", "Right-click"],
      ["Merge, rebase, cherry-pick", "Drag onto a branch"],
    ],
  },
  {
    title: "Changes",
    rows: [
      ["Commit", "Ctrl+Enter"],
      ["Close diff", "Esc"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      width={560}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="dialog-body shortcuts-grid">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([label, keys]) => (
                <div key={label} className="shortcut-row">
                  <dt>{label}</dt>
                  <dd>
                    {keys.includes("/") || keys.includes("Drag") || keys.includes("Right") ? (
                      <span className="muted">{keys}</span>
                    ) : (
                      <Shortcut keys={keys} />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
