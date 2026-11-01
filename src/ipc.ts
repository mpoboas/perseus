import { Channel, invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  id: number;
  path: string;
  name: string;
}

export interface CommitRow {
  oid: string;
  parents: string[];
  author: string;
  time: number;
  summary: string;
  refs: string[];
}

interface CommitChunk {
  seq: number;
  rows: CommitRow[];
}

export interface WalkSummary {
  total: number;
  cancelled: boolean;
}

export const pickAndOpenRepo = () => invoke<RepoInfo | null>("pick_and_open_repo");

export const closeRepo = (repoId: number) => invoke<void>("close_repo", { repoId });

export const cancelStream = (streamId: number) => invoke<void>("cancel_stream", { streamId });

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
