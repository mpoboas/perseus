/**
 * Tauri delivers a command's result and its channel messages separately, so the result (with the
 * final row count) can arrive before the last chunk of rows. This tracks what has arrived so the
 * caller can wait for the rows the backend says it sent.
 */
export interface RowTally {
  received: number;
  notify: (() => void) | null;
}

export const newTally = (): RowTally => ({ received: 0, notify: null });

/** Records `count` more rows and wakes anyone waiting in `waitForRows`. */
export function arrived(tally: RowTally, count: number) {
  tally.received += count;
  tally.notify?.();
}

/**
 * Resolves once `total` rows have arrived, or after `timeoutMs` so a lost message cannot hang the
 * load forever (the rows that did arrive are still shown).
 */
export function waitForRows(tally: RowTally, total: number, timeoutMs = 10_000): Promise<void> {
  if (tally.received >= total) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      tally.notify = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    tally.notify = () => {
      if (tally.received >= total) finish();
    };
  });
}
