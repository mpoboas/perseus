import { Channel, invoke } from "@tauri-apps/api/core";

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
