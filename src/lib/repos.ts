import type { RecentRepo, RemoteRepo } from "../ipc";

/** What the user sees for a repository: their own name for it, else the folder's. */
export const repoLabel = (r: { name: string; alias?: string | null }): string => r.alias || r.name;

export interface TabRef {
  path: string;
  name: string;
}

/** A tab shows the repository's alias when it has one. */
export function tabLabel(tab: TabRef, recents: RecentRepo[]): string {
  const r = recents.find((x) => x.path === tab.path);
  return r ? repoLabel(r) : tab.name;
}

/** A link that opens this folder (and optionally selects a commit) in Perseus, from anywhere. */
export function perseusLink(path: string, commit?: string): string {
  const query = new URLSearchParams({ path });
  if (commit) query.set("commit", commit);
  return `perseus-app://open?${query.toString()}`;
}

/** Favorites by name first, then the rest as given (newest first). */
export function splitRecents(list: RecentRepo[]): { favorites: RecentRepo[]; others: RecentRepo[] } {
  const favorites = list
    .filter((r) => r.favorite)
    .sort((a, b) => repoLabel(a).localeCompare(repoLabel(b), undefined, { sensitivity: "base" }));
  return { favorites, others: list.filter((r) => !r.favorite) };
}

// ---- Tab sets: each profile keeps its own open repositories ----

export interface TabSet {
  tabs: TabRef[];
  /** The repository that was in front. */
  last: string | null;
}

/** Saved sets by profile id; the key for "no profile" (the system's Git configuration) is the empty string. */
export type TabSets = Record<string, TabSet>;

export const tabSetKey = (profileId: string | null): string => profileId ?? "";

/**
 * Switching from one profile to another: the tabs now open are kept for `from`, and the tabs kept
 * for `to` (if it has any) come back. `next` is null when `to` has no saved set yet.
 */
export function swapTabSets(
  sets: TabSets,
  from: string | null,
  to: string | null,
  current: TabSet,
): { sets: TabSets; next: TabSet | null } {
  const saved = { ...sets, [tabSetKey(from)]: current };
  return { sets: saved, next: saved[tabSetKey(to)] && tabSetKey(to) !== tabSetKey(from) ? saved[tabSetKey(to)] : null };
}

/** The saved tabs that can still be opened, and the one to show: the remembered one if it survives. */
export function restoreTabs(set: TabSet, usable: (path: string) => boolean): { tabs: TabRef[]; show: string | null } {
  const tabs = set.tabs.filter((t) => usable(t.path));
  const show = set.last && tabs.some((t) => t.path === set.last) ? set.last : (tabs[tabs.length - 1]?.path ?? null);
  return { tabs, show };
}

/** Sizes git reports in KiB, written for people. */
export function kibytes(kib: number): string {
  if (kib < 1024) return `${kib} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
  const gib = mib / 1024;
  return `${gib < 10 ? gib.toFixed(1) : Math.round(gib)} GiB`;
}

/** Repositories grouped under their owner, in the order each owner first appears (the host lists the most recently active first). */
export function groupByOwner(repos: RemoteRepo[]): { owner: string; repos: RemoteRepo[] }[] {
  const groups = new Map<string, RemoteRepo[]>();
  for (const r of repos) groups.set(r.owner, [...(groups.get(r.owner) ?? []), r]);
  return [...groups].map(([owner, list]) => ({ owner, repos: list }));
}

/** A name the hosts accept for a new repository (mirrors the backend's check, so the form can say so before asking). */
export function validRepoName(name: string): boolean {
  const n = name.trim();
  return (
    /^[A-Za-z0-9._-]{1,100}$/.test(n) && !/^[-.]/.test(n) && !/\.$/.test(n) && !n.includes("..") && !n.endsWith(".git")
  );
}
