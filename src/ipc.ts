import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { arrived, newTally, waitForRows } from "./lib/streamWait";

export interface RepoInfo {
  id: number;
  path: string;
  name: string;
}

/** `[lane, color]` */
export type Segment = [number, number];

export interface LaneRow {
  lane: number;
  color: number;
  incoming: Segment[];
  through: Segment[];
  outgoing: Segment[];
}

export interface CommitRow {
  oid: string;
  parents: string[];
  author: string;
  author_email: string;
  time: number;
  summary: string;
  refs: string[];
  graph: LaneRow;
}

interface CommitChunk {
  seq: number;
  rows: CommitRow[];
}

export interface WalkSummary {
  total: number;
  cancelled: boolean;
}

export interface RefInfo {
  name: string;
  kind: "branch" | "remote" | "tag";
  target: string;
  is_head: boolean;
  /** Upstream of a local branch, e.g. `origin/main`. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream branch was deleted on the remote. */
  gone: boolean;
}

export interface Person {
  name: string;
  email: string;
  time: number;
}

export interface CommitDetail {
  oid: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export const pickAndOpenRepo = () => invoke<RepoInfo | null>("pick_and_open_repo");

export const closeRepo = (repoId: number) => invoke<void>("close_repo", { repoId });

export const cancelStream = (streamId: number) => invoke<void>("cancel_stream", { streamId });

export const listRefs = (repoId: number) => invoke<RefInfo[]>("list_refs", { repoId });

export const commitDetail = (repoId: number, oid: string) =>
  invoke<CommitDetail>("commit_detail", { repoId, oid });

// ---- Working tree, writes and diffs ----

/** Line counts of a change; a null count means a binary file. */
export interface LineStats {
  additions: number | null;
  deletions: number | null;
}

export interface StatusEntry {
  path: string;
  orig_path: string | null;
  /** Staged change code: M, A, D, R, C, T. */
  index: string | null;
  /** Unstaged change code. */
  worktree: string | null;
  untracked: boolean;
  conflicted: boolean;
  index_stats: LineStats | null;
  worktree_stats: LineStats | null;
}

export type Operation = "merge" | "cherry_pick" | "rebase" | "revert";

export interface RepoStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
  operation: Operation | null;
}

export interface FileChange {
  path: string;
  orig_path: string | null;
  status: string;
  stats: LineStats | null;
}

export type SwitchTarget = { kind: "branch"; name: string } | { kind: "detached"; oid: string };

/** What `pull` does when the branch has diverged: refuse (default), merge, or rebase. */
export type PullMode = "ff_only" | "merge" | "rebase";

export type GitOp =
  | { op: "fetch"; prune?: boolean }
  | { op: "pull"; mode?: PullMode }
  | {
      op: "push";
      set_upstream?: boolean;
      remote?: string;
      /** Overwrite the remote branch only if nobody pushed since our last fetch. */
      force_with_lease?: boolean;
      tags?: boolean;
    }
  | { op: "merge"; rev: string }
  | { op: "cherry_pick"; oid: string }
  | { op: "rebase"; onto: string }
  | { op: "abort" }
  | { op: "continue" };

export type WorkSide = "unstaged" | "staged" | "untracked";

export type DiffTarget =
  | { kind: "commit"; oid: string; path: string; orig?: string | null }
  | { kind: "work"; side: WorkSide; path: string; orig?: string | null };

export const repoStatus = (repoId: number) => invoke<RepoStatus>("repo_status", { repoId });

export const commitFiles = (repoId: number, oid: string) =>
  invoke<FileChange[]>("commit_files", { repoId, oid });

export const stagePaths = (repoId: number, paths: string[]) =>
  invoke<void>("stage_paths", { repoId, paths });

export const unstagePaths = (repoId: number, paths: string[]) =>
  invoke<void>("unstage_paths", { repoId, paths });

export const createCommit = (repoId: number, message: string, amend: boolean, noVerify = false) =>
  invoke<void>("create_commit", { repoId, message, amend, noVerify });

export const switchRef = (repoId: number, target: SwitchTarget) =>
  invoke<void>("switch_ref", { repoId, target });

export const newBranch = (repoId: number, name: string, start: string | null, checkout: boolean) =>
  invoke<void>("new_branch", { repoId, name, start, checkout });

/**
 * Runs fetch/pull/push/merge/…; `onProgress` receives git's progress lines as they arrive.
 * `cancelGitOp(opId)` stops it.
 */
export function runGitOp(
  repoId: number,
  op: GitOp,
  onProgress: (line: string) => void,
  opId: number,
): Promise<string> {
  const channel = new Channel<string>();
  channel.onmessage = onProgress;
  return invoke<string>("run_git_op", { repoId, opId, op, onProgress: channel });
}

let nextOpId = 1;
export const newOpId = () => nextOpId++;

export const cancelGitOp = (opId: number) => invoke<void>("cancel_git_op", { opId });

// ---- Everyday actions: stash, tags, branches, reset, revert, discard, remotes ----

/** Which part of a diff to take, as the user saw it (the backend refuses if the file has changed). */
export interface HunkPick {
  hunk: number;
  header: string;
  checksum: number;
  /** Indices of the `+`/`-` lines inside the hunk; null takes the whole hunk. */
  lines: number[] | null;
}

export type PatchMode = "stage" | "unstage" | "discard";

export type ResetMode = "soft" | "mixed" | "hard";

export type GitAction =
  | { action: "stash_push"; message?: string | null; include_untracked?: boolean }
  | { action: "stash_apply"; index: number }
  | { action: "stash_pop"; index: number }
  | { action: "stash_drop"; index: number }
  | { action: "tag_create"; name: string; target?: string | null; message?: string | null }
  | { action: "tag_delete"; name: string }
  | { action: "tag_push"; name: string; remote?: string | null }
  | { action: "tag_delete_remote"; name: string; remote?: string | null }
  | { action: "branch_delete"; name: string; force?: boolean }
  | { action: "branch_delete_remote"; remote: string; name: string }
  | { action: "branch_rename"; old: string; new: string }
  | { action: "set_upstream"; branch: string; upstream?: string | null }
  | { action: "reset"; mode: ResetMode; target: string }
  | { action: "revert"; oid: string; mainline?: number | null }
  | { action: "discard"; paths: string[]; untracked?: boolean }
  | { action: "patch"; path: string; mode: PatchMode; hunks: HunkPick[] }
  | { action: "remote_add"; name: string; url: string }
  | { action: "remote_remove"; name: string }
  | { action: "remote_rename"; old: string; new: string }
  | { action: "remote_set_url"; name: string; url: string };

export interface StashEntry {
  index: number;
  message: string;
  /** Unix seconds. */
  time: number;
}

export interface RemoteInfo {
  name: string;
  fetch_url: string;
  push_url: string;
}

export const gitAction = (repoId: number, action: GitAction) =>
  invoke<void>("git_action", { repoId, action });

export const listStashes = (repoId: number) => invoke<StashEntry[]>("list_stashes", { repoId });

export const listRemotes = (repoId: number) => invoke<RemoteInfo[]>("list_remotes", { repoId });

export interface Patch {
  text: string;
  /** The backend cut the patch off at its size cap. */
  truncated: boolean;
}

/**
 * Fetches a unified patch over the `perseus://` protocol: raw bytes, no JSON/Base64
 * wrapping. `convertFileSrc` yields the right URL form per platform
 * (`http://perseus.localhost` on Windows, `perseus://localhost` elsewhere).
 */
export async function fetchPatch(
  repoId: number,
  target: DiffTarget,
  signal?: AbortSignal,
): Promise<Patch> {
  const params = new URLSearchParams({ repo: String(repoId), path: target.path });
  if (target.orig) params.set("orig", target.orig);
  if (target.kind === "commit") params.set("oid", target.oid);
  else params.set("side", target.side);

  const base = convertFileSrc(target.kind === "commit" ? "diff" : "wdiff", "perseus");
  const res = await fetch(`${base}?${params}`, { signal });
  if (!res.ok) throw new Error((await res.text()) || `request failed (${res.status})`);
  return { text: await res.text(), truncated: res.headers.get("x-perseus-truncated") === "1" };
}

export interface FileBytes {
  bytes: ArrayBuffer;
  /** The backend cut the file off at its size cap. */
  truncated: boolean;
}

/**
 * One version of a file over the `perseus://` protocol, or null when that version has none (a file
 * that was just added has no "before"). `rev` is a commit id, `<id>^` for its parent, or one of
 * `head`, `index` and `work`.
 */
export async function fetchBlob(
  repoId: number,
  path: string,
  rev: string,
  signal?: AbortSignal,
): Promise<FileBytes | null> {
  const params = new URLSearchParams({ repo: String(repoId), path, rev });
  const res = await fetch(`${convertFileSrc("blob", "perseus")}?${params}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error((await res.text()) || `request failed (${res.status})`);
  return { bytes: await res.arrayBuffer(), truncated: res.headers.get("x-perseus-truncated") === "1" };
}

// ---- Profiles (identity, SSH key, host tokens) ----
// Tokens are write-only from the UI's point of view: they are sent once to be put in
// the OS keychain, and only non-secret metadata (host, username) ever comes back.

export interface CredentialMeta {
  host: string;
  username: string;
  /** True when the token came from an OAuth sign-in and renews itself. */
  oauth: boolean;
}

export interface Profile {
  id: string;
  name: string;
  user_name: string;
  user_email: string;
  ssh_key: string | null;
  /** `ssh` or `gpg`; commits are signed when a key is set too. */
  signing_format: string | null;
  signing_key: string | null;
  credentials: CredentialMeta[];
}

export interface ProfilesSnapshot {
  profiles: Profile[];
  active: string | null;
  /** False when the credential helper binary is missing next to the app. */
  helper_available: boolean;
}

export interface ProfileInput {
  id?: string | null;
  name: string;
  user_name: string;
  user_email: string;
  ssh_key: string | null;
  signing_format?: string | null;
  signing_key?: string | null;
}

export const listProfiles = () => invoke<ProfilesSnapshot>("list_profiles");

export const saveProfile = (input: ProfileInput) => invoke<Profile>("save_profile", { input });

export const deleteProfile = (id: string) => invoke<void>("delete_profile", { id });

export const setActiveProfile = (id: string | null) =>
  invoke<void>("set_active_profile", { id });

export const setCredential = (id: string, host: string, username: string, token: string) =>
  invoke<void>("set_credential", { id, host, username, token });

export const removeCredential = (id: string, host: string) =>
  invoke<void>("remove_credential", { id, host });

export const pickSshKey = () => invoke<string | null>("pick_ssh_key");

// ---- OAuth sign-in (device flow) ----

export type OAuthKind = "github" | "gitlab";

export interface OAuthPreset {
  kind: OAuthKind;
  label: string;
  host: string;
  /** This build ships a client ID for the host; otherwise the user supplies one. */
  configured: boolean;
}

export interface SignInCode {
  event: "code";
  user_code: string;
  verification_uri: string;
  expires_in: number;
  /** Whether Perseus managed to open the page in the browser. */
  opened: boolean;
}

export interface SignInRequest {
  profile_id: string;
  kind: OAuthKind;
  host: string;
  client_id?: string | null;
}

export const oauthPresets = () => invoke<OAuthPreset[]>("oauth_presets");

export const oauthCancel = (flowId: number) => invoke<void>("oauth_cancel", { flowId });

let nextFlowId = 1;

/** Starts a sign-in. `done` resolves once the token is in the keychain. */
export function oauthSignIn(
  request: SignInRequest,
  onCode: (code: SignInCode) => void,
): { flowId: number; done: Promise<void> } {
  const flowId = nextFlowId++;
  const channel = new Channel<SignInCode>();
  channel.onmessage = onCode;
  const done = invoke<void>("oauth_sign_in", { request, flowId, onEvent: channel });
  return { flowId, done };
}

let nextStreamId = 1;

/** Starts a commit stream. Chunks arrive in order via `onChunk`; returns the stream id for cancelling. */
export function streamCommits(
  repoId: number,
  onChunk: (rows: CommitRow[]) => void,
  filter: GraphFilter | null = null,
): { streamId: number; done: Promise<WalkSummary> } {
  const streamId = nextStreamId++;
  const channel = new Channel<CommitChunk>();
  const tally = newTally();
  channel.onmessage = (chunk) => {
    arrived(tally, chunk.rows.length);
    onChunk(chunk.rows);
  };
  // The result can overtake the last chunk: resolve only once every row has been handed over,
  // or a silent reload would swap in a store that is still empty.
  const done = invoke<WalkSummary>("stream_commits", { repoId, streamId, filter, onChunk: channel }).then(
    async (summary) => {
      if (!summary.cancelled) await waitForRows(tally, summary.total);
      return summary;
    },
  );
  return { streamId, done };
}

// ---- Recent repositories ----

export interface RecentRepo {
  path: string;
  name: string;
  /** Unix seconds. */
  last_opened: number;
  /** False when the folder has since been moved or deleted. */
  exists: boolean;
}

export const listRecentRepos = () => invoke<RecentRepo[]>("list_recent_repos");

/** Only paths already in the recents list are accepted; the backend refuses anything else. */
export const openRecentRepo = (path: string) => invoke<RepoInfo>("open_recent_repo", { path });

export const removeRecentRepo = (path: string) => invoke<void>("remove_recent_repo", { path });

// ---- Change notifications ----

/** What a batch of file-system changes means: re-read status (`worktree`) and/or refs and history (`refs`). */
export interface ChangeSet {
  refs: boolean;
  worktree: boolean;
}

let nextWatchId = 1;

/** Starts watching an open repository. Returns the watch id for `unwatchRepo`. */
export function watchRepo(repoId: number, onChange: (c: ChangeSet) => void): number {
  const watchId = nextWatchId++;
  const channel = new Channel<ChangeSet>();
  channel.onmessage = onChange;
  void invoke<void>("watch_repo", { repoId, watchId, onChange: channel });
  return watchId;
}

export const unwatchRepo = (watchId: number) => invoke<void>("unwatch_repo", { watchId });

// ---- File history, blame, patches, commit templates ----

export interface FileCommit {
  oid: string;
  summary: string;
  author: string;
  time: number;
}

export interface BlameLine {
  line: number;
  oid: string;
  author: string;
  time: number;
  summary: string;
  text: string;
}

export interface Blame {
  lines: BlameLine[];
  truncated: boolean;
}

export type PatchSource = { source: "commit"; oid: string } | { source: "worktree"; staged: boolean };

export const fileHistory = (repoId: number, path: string) =>
  invoke<FileCommit[]>("file_history", { repoId, path });

export const fileBlame = (repoId: number, path: string, rev: string | null) =>
  invoke<Blame>("file_blame", { repoId, path, rev });

export const commitTemplate = (repoId: number) => invoke<string | null>("commit_template", { repoId });

/** Opens a save dialog and writes the patch git generates; null when the user cancels. */
export const exportPatch = (repoId: number, source: PatchSource) =>
  invoke<{ name: string; bytes: number } | null>("export_patch", { repoId, source });

/** Opens a file dialog and applies the chosen patch (nothing changes if it does not fit). */
export const applyPatchFile = (repoId: number, toIndex: boolean) =>
  invoke<string | null>("apply_patch_file", { repoId, toIndex });

// ---- Graph filter, search, clone, open-in ----

/** Which refs the graph starts from: `hidden` refs are left out; with `solo` set only those show. */
export interface GraphFilter {
  hidden: string[];
  solo: string[];
}

export interface SearchQuery {
  text?: string;
  author?: string;
  since?: string;
  until?: string;
  path?: string;
}

export interface SearchHit {
  oid: string;
  summary: string;
  author: string;
  time: number;
}

export const searchCommits = (repoId: number, query: SearchQuery) =>
  invoke<{ hits: SearchHit[]; truncated: boolean }>("search_commits", { repoId, query });

/** Asks for a folder and runs `git init` there; null when the user cancels. */
/** `defaultBranch` names the first branch of the new repository (git's `init.defaultBranch`). */
export const initRepo = (defaultBranch?: string) => invoke<RepoInfo | null>("init_repo", { defaultBranch });

/** Asks where to put the clone; `cancelGitOp(opId)` stops it. Null when the user cancels the folder dialog. */
export function cloneRepo(
  url: string,
  opId: number,
  onProgress: (line: string) => void,
): Promise<RepoInfo | null> {
  const channel = new Channel<string>();
  channel.onmessage = onProgress;
  return invoke<RepoInfo | null>("clone_repo", { url, opId, onProgress: channel });
}

export type OpenIn = "folder" | "terminal" | "editor";

export const openIn = (repoId: number, target: OpenIn) => invoke<void>("open_in", { repoId, target });

// ---- Conflicts, interactive rebase, conflict prediction ----

export type ConflictKind =
  | "both_modified"
  | "both_added"
  | "deleted_by_us"
  | "deleted_by_them"
  | "added_by_us"
  | "added_by_them"
  | "both_deleted";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
}

export type ConflictSegment =
  | { type: "text"; text: string }
  | { type: "conflict"; ours: string; base: string | null; theirs: string };

export interface ConflictDetail {
  path: string;
  kind: ConflictKind;
  binary: boolean;
  segments: ConflictSegment[];
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

export type Resolution =
  | { how: "content"; text: string }
  | { how: "ours" }
  | { how: "theirs" }
  | { how: "delete" };

export interface PlanCommit {
  oid: string;
  summary: string;
  is_merge: boolean;
}

export type TodoAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface TodoItem {
  action: TodoAction;
  oid: string;
  message?: string | null;
}

export interface Prediction {
  /** False when this git is too old to preview a merge (before 2.38). */
  supported: boolean;
  conflicts: string[];
}

export const listConflicts = (repoId: number) => invoke<ConflictFile[]>("list_conflicts", { repoId });

export const conflictDetail = (repoId: number, path: string) =>
  invoke<ConflictDetail>("conflict_detail", { repoId, path });

export const resolveConflict = (repoId: number, path: string, resolution: Resolution) =>
  invoke<void>("resolve_conflict", { repoId, path, resolution });

export const rebasePlan = (repoId: number, base: string) => invoke<PlanCommit[]>("rebase_plan", { repoId, base });

export function interactiveRebase(
  repoId: number,
  base: string,
  items: TodoItem[],
  onProgress: (line: string) => void,
  opId: number,
): Promise<string> {
  const channel = new Channel<string>();
  channel.onmessage = onProgress;
  return invoke<string>("interactive_rebase", { repoId, opId, base, items, onProgress: channel });
}

export const predictMerge = (repoId: number, ours: string, theirs: string) =>
  invoke<Prediction>("predict_merge", { repoId, ours, theirs });

export const predictPick = (repoId: number, onto: string, oid: string) =>
  invoke<Prediction>("predict_pick", { repoId, onto, oid });

// ---- Hosting: pull requests, issues, CI ----

export interface HostingInfo {
  kind: "git_hub" | "git_lab";
  host: string;
  path: string;
  /** The active profile holds a token for this host. */
  signed_in: boolean;
  web_url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged" | string;
  draft: boolean;
  author: string;
  source_branch: string;
  target_branch: string;
  head_sha: string;
  url: string;
  updated: string;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  labels: string[];
  updated: string;
}

export type CiState = "success" | "failure" | "pending" | "none";
export type MergeMethod = "merge" | "squash" | "rebase";
export type PrFilter = "open" | "closed" | "all";

export const hostingInfo = (repoId: number) => invoke<HostingInfo | null>("hosting_info", { repoId });

export const listPullRequests = (repoId: number, filter: PrFilter) =>
  invoke<PullRequest[]>("list_pull_requests", { repoId, filter });

export const createPullRequest = (
  repoId: number,
  pullRequest: { title: string; body: string; head: string; base: string; draft: boolean },
) => invoke<PullRequest>("create_pull_request", { repoId, pullRequest });

export const mergePullRequest = (repoId: number, number: number, method: MergeMethod) =>
  invoke<void>("merge_pull_request", { repoId, number, method });

export const listIssues = (repoId: number) => invoke<Issue[]>("list_issues", { repoId });

export const ciState = (repoId: number, sha: string) => invoke<CiState>("ci_state", { repoId, sha });

/** Fetches the pull request into a local branch and checks it out; resolves with the branch name. */
export const checkoutPullRequest = (repoId: number, number: number) =>
  invoke<string>("checkout_pull_request", { repoId, number });

export const openInBrowser = (repoId: number, url: string) => invoke<void>("open_in_browser", { repoId, url });

// ---- Prompts from git and ssh, signing ----

export interface Question {
  id: number;
  prompt: string;
  kind: "secret" | "text" | "confirm" | "info";
}

/** Questions from git and ssh (passwords, passphrases, "trust this host?") arrive here. */
export function watchAskpass(onQuestion: (q: Question) => void): void {
  const channel = new Channel<Question>();
  channel.onmessage = onQuestion;
  void invoke<void>("watch_askpass", { onQuestion: channel });
}

/** `null` cancels the question. The answer goes straight to the waiting git or ssh process. */
export const answerAskpass = (id: number, answer: string | null) => invoke<void>("answer_askpass", { id, answer });

export interface Signature {
  status: "good" | "bad" | "unknown" | "expired" | "none" | "error";
  signer: string | null;
  key: string | null;
}

export const commitSignature = (repoId: number, oid: string) =>
  invoke<Signature>("commit_signature", { repoId, oid });

export const generateSshKey = (label: string, comment: string) =>
  invoke<{ path: string; public_key: string }>("generate_ssh_key", { label, comment });

// ---- Submodules, worktrees, LFS, large files, activity log ----

export interface Submodule {
  path: string;
  state: "clean" | "uninitialized" | "modified" | "conflicted";
  oid: string;
  describe: string | null;
}
export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  locked: boolean;
}
export interface LfsStatus {
  installed: boolean;
  patterns: string[];
}
export interface LargeFile {
  path: string;
  bytes: number;
}
export interface LogEntry {
  time: number;
  command: string;
  millis: number;
  ok: boolean;
  error: string | null;
  read_only: boolean;
}

export const listSubmodules = (repoId: number) => invoke<Submodule[]>("list_submodules", { repoId });
export const updateSubmodules = (repoId: number, path: string | null) =>
  invoke<void>("update_submodules", { repoId, path });
/** Opens a submodule (relative path) or linked worktree (as listed) of this repository. */
export const openNestedRepo = (repoId: number, path: string) => invoke<RepoInfo>("open_nested_repo", { repoId, path });
export const listWorktrees = (repoId: number) => invoke<Worktree[]>("list_worktrees", { repoId });
/** Asks for a folder; resolves to the new worktree's path, or `null` when the user cancelled. */
export const addWorktree = (repoId: number, branch: string, create: boolean) =>
  invoke<string | null>("add_worktree", { repoId, branch, create });
export const removeWorktree = (repoId: number, path: string) => invoke<void>("remove_worktree", { repoId, path });
export const lfsStatus = (repoId: number) => invoke<LfsStatus>("lfs_status", { repoId });
export const lfsTrack = (repoId: number, pattern: string) => invoke<void>("lfs_track", { repoId, pattern });
export const largeStagedFiles = (repoId: number, megabytes: number) =>
  invoke<LargeFile[]>("large_staged_files", { repoId, megabytes });
export const activityLog = () => invoke<LogEntry[]>("activity_log");

/** A `data:` URL with the author's GitHub picture, or null when there is none (see `avatars.rs`). */
export const authorAvatar = (repoId: number, email: string, sha: string, gravatar: boolean) =>
  invoke<string | null>("author_avatar", { repoId, email, sha, gravatar });

/** The picture of the account that owns the repository's GitHub remote, if there is one. */
export const remoteAvatar = (repoId: number) => invoke<string | null>("remote_avatar", { repoId });

// ---- Undo and redo ----

/** What undo puts back: branches, tags, stashes and, for edits to files, the staged and on-disk trees. */
export interface UndoSnapshot {
  branch: string | null;
  head: string | null;
  branches: { name: string; oid: string }[];
  tags: { name: string; oid: string }[];
  stashes: { oid: string; message: string }[];
  files: { index: string; work: string } | null;
}

/** `files` also records the tracked files (slower on a big working tree). */
export const undoSnapshot = (repoId: number, files = false) =>
  invoke<UndoSnapshot>("undo_snapshot", { repoId, files });

/**
 * `keepChanges` moves the checked-out branch with a soft reset (an undone commit stays staged).
 * `from` is the state being left, so edits to files are only undone while they are as that action left them.
 */
export const undoRestore = (repoId: number, snapshot: UndoSnapshot, keepChanges: boolean, from?: UndoSnapshot) =>
  invoke<void>("undo_restore", { repoId, snapshot, keepChanges, from: from ?? null });
