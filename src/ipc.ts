import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";

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

export type GitOp =
  | { op: "fetch" }
  | { op: "pull" }
  | { op: "push"; set_upstream?: boolean; remote?: string }
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

export const createCommit = (repoId: number, message: string, amend: boolean) =>
  invoke<void>("create_commit", { repoId, message, amend });

export const switchRef = (repoId: number, target: SwitchTarget) =>
  invoke<void>("switch_ref", { repoId, target });

export const newBranch = (repoId: number, name: string, start: string | null, checkout: boolean) =>
  invoke<void>("new_branch", { repoId, name, start, checkout });

/** Runs fetch/pull/push/merge/…; `onProgress` receives git's progress lines as they arrive. */
export function runGitOp(
  repoId: number,
  op: GitOp,
  onProgress: (line: string) => void,
): Promise<string> {
  const channel = new Channel<string>();
  channel.onmessage = onProgress;
  return invoke<string>("run_git_op", { repoId, op, onProgress: channel });
}

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
): { streamId: number; done: Promise<WalkSummary> } {
  const streamId = nextStreamId++;
  const channel = new Channel<CommitChunk>();
  channel.onmessage = (chunk) => onChunk(chunk.rows);
  const done = invoke<WalkSummary>("stream_commits", { repoId, streamId, onChunk: channel });
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
