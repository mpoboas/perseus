import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { type Key, useT } from "../i18n";
import {
  SHORTCUTS,
  type ShortcutDef,
  type ShortcutGroup,
  type ShortcutId,
  bindingFromEvent,
  bindingProblem,
  conflictFor,
  sameBinding,
  resolve,
  useShortcutOverrides,
} from "../lib/shortcuts";
import { Button, IconButton, Shortcut } from "../ui";
import { Section } from "./fields";

const GROUPS: ShortcutGroup[] = ["General", "View", "Changes"];

interface Pending {
  id: ShortcutId;
  binding: string;
  /** What the new binding collides with, when it does. */
  conflict: ShortcutId | null;
}

/**
 * Every rebindable shortcut, with a recorder: press "Change", then the keys you want. A binding that is
 * already used by something else is shown first and only taken when you confirm, so nothing stops
 * working by accident. Changes save at once, like the rest of Settings.
 */
export function ShortcutsPage() {
  const t = useT();
  const name = (id: ShortcutId) => t(`shortcut.${id}` as Key);
  const [overrides, setOverrides] = useShortcutOverrides();
  const bindings = resolve(overrides);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [problem, setProblem] = useState<Key | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // Everything typed while recording belongs to the recorder, not to the app's own shortcuts.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setProblem(null);
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return; // only a modifier so far: wait for the real key
      const why = bindingProblem(binding);
      if (why) {
        setProblem(why);
        return;
      }
      setProblem(null);
      setRecording(null);
      const conflict = conflictFor(bindings, recording, binding);
      if (conflict) setPending({ id: recording, binding, conflict });
      else assign(recording, binding);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // `assign` and `bindings` come from the render that started recording; the recorder is rebuilt when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides]);

  const assign = (id: ShortcutId, binding: string, takeFrom?: ShortcutId) =>
    setOverrides((prev) => {
      const next = { ...prev, [id]: [binding] };
      if (takeFrom) next[takeFrom] = resolve(prev)[takeFrom].filter((b) => !sameBinding(b, binding));
      return next;
    });

  const reset = (id: ShortcutId) =>
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const unbind = (id: ShortcutId) => setOverrides((prev) => ({ ...prev, [id]: [] }));

  const row = (s: ShortcutDef) => {
    const own = bindings[s.id];
    const changed = overrides[s.id] !== undefined;
    const isRecording = recording === s.id;
    return (
      <div key={s.id} className="set-row" data-recording-shortcut={isRecording || undefined}>
        <span className="set-label">{name(s.id)}</span>
        <div className="set-control">
          <div className="set-inline sc-row">
            {isRecording ? (
              <span className="sc-recording" role="status">
                {t("shortcutsPage.recording")}
              </span>
            ) : own.length > 0 ? (
              own.map((b) => <Shortcut key={b} keys={b} />)
            ) : (
              <span className="muted">{t("shortcut.notAssigned")}</span>
            )}
            <Button
              size="sm"
              aria-label={t("shortcutsPage.changeFor", { action: name(s.id) })}
              onClick={() => {
                setPending(null);
                setProblem(null);
                setRecording(isRecording ? null : s.id);
              }}
            >
              {t(isRecording ? "shortcutsPage.cancel" : "shortcutsPage.change")}
            </Button>
            {own.length > 0 && !isRecording && (
              <IconButton icon={X} label={t("shortcutsPage.removeFor", { action: name(s.id) })} size="sm" onClick={() => unbind(s.id)} />
            )}
            {changed && !isRecording && (
              <IconButton icon={RotateCcw} label={t("shortcutsPage.restoreFor", { action: name(s.id) })} size="sm" onClick={() => reset(s.id)} />
            )}
          </div>
          {isRecording && problem && (
            <p className="set-warn" role="alert">
              {t(problem)}
            </p>
          )}
          {pending?.id === s.id && (
            <p className="set-warn" role="alert">
              {t("shortcutsPage.taken", { action: name(pending.conflict!) })}{" "}
              <Button
                size="sm"
                onClick={() => {
                  assign(pending.id, pending.binding, pending.conflict!);
                  setPending(null);
                }}
              >
                {t("shortcutsPage.useHere")}
              </Button>{" "}
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                {t("shortcutsPage.keepOld")}
              </Button>
            </p>
          )}
        </div>
      </div>
    );
  };

  const anyChanged = Object.keys(overrides).length > 0;
  return (
    <>
      <p className="set-note">{t("shortcutsPage.intro")}</p>
      {GROUPS.map((g) => (
        <Section key={g} title={t(`shortcut.group.${g}` as Key)}>
          {SHORTCUTS.filter((s) => s.group === g).map(row)}
        </Section>
      ))}
      {anyChanged && (
        <Section>
          <Button onClick={() => setOverrides({})}>{t("shortcutsPage.restoreAll")}</Button>
        </Section>
      )}
    </>
  );
}
