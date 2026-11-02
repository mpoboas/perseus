import { CircleAlert, GitCommitVertical, User } from "lucide-react";
import type { RepoInfo } from "./ipc";
import { Spinner } from "./ui";

interface Props {
  repo: RepoInfo | null;
  busy: string | null;
  progress: string;
  loading: boolean;
  /** Shown once history has loaded, e.g. "1,807 commits · 0.27s". */
  loaded: string;
  commitCount: number;
  identity: { name: string; email: string } | null;
  lastError: string | null;
  onShowError: () => void;
}

export function StatusBar({ repo, busy, progress, loading, loaded, commitCount, identity, lastError, onShowError }: Props) {
  return (
    <footer className="statusbar">
      <div className="sb-left">
        {busy ? (
          <span className="sb-busy" role="status">
            <Spinner size={12} />
            <strong>{busy}</strong>
            {progress && <span className="sb-progress">{progress}</span>}
          </span>
        ) : loading ? (
          <span className="sb-busy" role="status">
            <Spinner size={12} />
            Reading history… {commitCount.toLocaleString()} commits
          </span>
        ) : repo ? (
          <span className="sb-item sb-path selectable" title={repo.path}>
            {repo.path}
          </span>
        ) : (
          <span className="sb-item">Ready</span>
        )}
      </div>
      <div className="sb-right">
        {lastError && (
          <button className="sb-item sb-error" onClick={onShowError} title="Show the last error again">
            <CircleAlert size={12} /> Last operation failed
          </button>
        )}
        {repo && loaded && (
          <span className="sb-item" title="Time to read the full history">
            <GitCommitVertical size={12} /> {loaded}
          </span>
        )}
        <span className="sb-item" title={identity ? `${identity.name} <${identity.email}>` : "Using your Git configuration"}>
          <User size={12} /> {identity ? identity.name : "Git default identity"}
        </span>
      </div>
    </footer>
  );
}
