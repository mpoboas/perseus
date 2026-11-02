/** Preference keys (stored under `perseus.<key>` in localStorage), shared by the settings pages and the app. */
export const KEYS = {
  autoFetch: "git.autoFetchMinutes",
  autoPrune: "git.autoPrune",
  defaultBranch: "git.defaultBranch",
  largeFile: "largeFileMegabytes",
  showReads: "log.showReads",
  toolbarLabels: "ui.toolbarLabels",
  dateStyle: "layout.dateStyle",
  graphRefs: "graph.showRefs",
  graphAuthor: "graph.showAuthor",
  graphDate: "graph.showDate",
  graphGhost: "graph.ghostBranch",
  graphBands: "graph.bands",
} as const;

/** Staged files above this many megabytes trigger a warning (0 turns it off). */
export const LARGE_FILE_DEFAULT = 50;

/** Settings that belong to one repository, keyed by its folder. */
export const repoKey = (path: string, name: "pushAfterCommit" | "skipHooks") => `repo.${path}.${name}`;

/** The profile pinned to a repository (see the profile menu in the toolbar). */
export const pinnedProfileKey = (path: string) => `repoProfile.${path}`;
