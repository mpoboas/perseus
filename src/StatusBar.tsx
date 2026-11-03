import { CircleAlert, GitCommitVertical, User } from "lucide-react";
import type { RepoInfo } from "./ipc";
import { useT } from "./i18n";
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
  /** Stops the running network operation, when there is one. */
  onCancel?: () => void;
}

export function StatusBar({ repo, busy, progress, loading, loaded, commitCount, identity, lastError, onShowError, onCancel }: Props) {
  const t = useT();
  return (
    <footer className="statusbar">
      <div className="sb-left">
        {busy ? (
          <span className="sb-busy" role="status">
            <Spinner size={12} />
            <strong>{busy}</strong>
            {progress && <span className="sb-progress">{progress}</span>}
            {onCancel && (
              <button className="sb-cancel" onClick={onCancel}>
                {t("status.cancel")}
              </button>
            )}
          </span>
        ) : loading ? (
          <span className="sb-busy" role="status">
            <Spinner size={12} />
            {t("status.reading", { count: commitCount.toLocaleString() })}
          </span>
        ) : repo ? (
          <span className="sb-item sb-path selectable" title={repo.path}>
            {repo.path}
          </span>
        ) : (
          <span className="sb-item">{t("status.ready")}</span>
        )}
      </div>
      <div className="sb-right">
        {lastError && (
          <button className="sb-item sb-error" onClick={onShowError} title={t("status.showError")}>
            <CircleAlert size={12} /> {t("status.lastFailed")}
          </button>
        )}
        {repo && loaded && (
          <span className="sb-item" title={t("status.historyTime")}>
            <GitCommitVertical size={12} /> {loaded}
          </span>
        )}
        <span className="sb-item" title={identity ? `${identity.name} <${identity.email}>` : t("status.usingGitConfig")}>
          <User size={12} /> {identity ? identity.name : t("status.gitDefaultIdentity")}
        </span>
      </div>
    </footer>
  );
}
