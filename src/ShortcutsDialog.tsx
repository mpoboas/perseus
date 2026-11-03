import { type Key, useT } from "./i18n";
import { FIXED_SHORTCUTS, SHORTCUTS, useBindings } from "./lib/shortcuts";
import { Button, Dialog, Shortcut } from "./ui";

const GROUPS = ["General", "View", "Graph", "Changes"] as const;

export function ShortcutsDialog({ onClose, onCustomize }: { onClose: () => void; onCustomize: () => void }) {
  const t = useT();
  const bindings = useBindings();
  return (
    <Dialog
      title={t("shortcut.dialogTitle")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onCustomize}>{t("shortcut.customize")}</Button>
          <Button variant="primary" onClick={onClose}>
            {t("shortcut.done")}
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
              <h3>{t(`shortcut.group.${g}` as Key)}</h3>
              <dl>
                {own.map((s) => (
                  <div key={s.id} className="shortcut-row">
                    <dt>{t(`shortcut.${s.id}` as Key)}</dt>
                    <dd>
                      {bindings[s.id].length === 0 ? (
                        <span className="muted">{t("shortcut.notAssigned")}</span>
                      ) : (
                        bindings[s.id].slice(0, 2).map((b) => <Shortcut key={b} keys={b} />)
                      )}
                    </dd>
                  </div>
                ))}
                {fixed.map((s) => (
                  <div key={s.id} className="shortcut-row">
                    <dt>{t(`shortcut.fixed.${s.id}` as Key)}</dt>
                    <dd>
                      <span className="muted">{s.translated ? t(s.keys as Key) : s.keys}</span>
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
