import { useCallback, useEffect, useState } from "react";

/** Values from this session, so a preference still works when localStorage is blocked. */
const session = new Map<string, unknown>();

/** localStorage can throw or be empty (private windows, blocked storage): fall back silently. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`perseus.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return session.has(key) ? (session.get(key) as T) : fallback;
  }
}

/** Components that show a preference hear about changes made anywhere else (the settings page). */
const listeners = new Map<string, Set<() => void>>();

function write(key: string, value: unknown) {
  session.set(key, value);
  try {
    localStorage.setItem(`perseus.${key}`, JSON.stringify(value));
  } catch {
    /* preferences are a convenience, never a requirement */
  }
  listeners.get(key)?.forEach((notify) => notify());
}

export { read as readPref, write as writePref };

/** Like `useState`, but remembered between launches and shared by every component using the key. */
export function usePref<T>(key: string, fallback: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  useEffect(() => {
    const notify = () => setValue(read(key, fallback));
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(notify);
    // A change may have happened between the first render and this effect.
    notify();
    return () => {
      set.delete(notify);
    };
    // `fallback` is a default value, not a dependency: it must not re-subscribe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(read(key, fallback)) : next;
      write(key, resolved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
