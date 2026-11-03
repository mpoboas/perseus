import type { CommitRow, RefInfo } from "../ipc";
import { absoluteTime } from "./format";

/**
 * What a screen reader says for a commit row of the graph. The graph is drawn on a canvas, which assistive
 * technology cannot read, so the visible rows are mirrored as a list of options with these descriptions.
 */
export function describeCommit(row: CommitRow, kinds: ReadonlyMap<string, RefInfo["kind"]>): string {
  const parts = [row.summary || "No message", `by ${row.author}`, absoluteTime(row.time)];
  const labels: string[] = [];
  for (const ref of row.refs) {
    if (ref === "HEAD") labels.push("checked out");
    else if (kinds.get(ref) === "tag") labels.push(`tag ${ref}`);
    else if (kinds.get(ref) === "remote") labels.push(`remote branch ${ref}`);
    else labels.push(`branch ${ref}`);
  }
  if (labels.length > 0) parts.push(labels.join(", "));
  if (row.parents.length > 1) parts.push(`merge of ${row.parents.length} commits`);
  else if (row.parents.length === 0) parts.push("first commit");
  return parts.join(", ");
}

export function describeWip(files: number): string {
  return files === 0 ? "No uncommitted changes" : `Uncommitted changes in ${files} ${files === 1 ? "file" : "files"}`;
}

/** The display rows to mirror: those on screen (with a small margin so scrolling by keys finds them ready) plus the selected one. */
export function mirroredRows(first: number, last: number, selected: number | null, total: number): number[] {
  const out = new Set<number>();
  for (let d = Math.max(0, first - 2); d <= Math.min(total - 1, last + 2); d++) out.add(d);
  if (selected !== null && selected >= 0 && selected < total) out.add(selected);
  return [...out].sort((a, b) => a - b);
}
