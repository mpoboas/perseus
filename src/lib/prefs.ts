import { useCallback, useState } from "react";

/** localStorage can throw or be empty (private windows, blocked storage): fall back silently. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`perseus.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(`perseus.${key}`, JSON.stringify(value));
  } catch {
    /* preferences are a convenience, never a requirement */
  }
}

export { read as readPref, write as writePref };

/** Like `useState`, but remembered between launches. */
export function usePref<T>(key: string, fallback: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        write(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
