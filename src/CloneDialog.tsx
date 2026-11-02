import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Globe, GitFork, Lock, LockOpen, Search, TriangleAlert } from "lucide-react";
import { FolderField, hostLabel, hostSources, type Source, SourceRail } from "./AccountParts";
import {
  type ChosenFolder,
  type HostAccount,
  hostAccounts,
  listNamespaces,
  listRemoteRepositories,
  type RemoteRepo,
} from "./ipc";
import { groupByOwner } from "./lib/repos";
import { Button, Dialog, TextField } from "./ui";

interface Props {
  /** Clones the address into the chosen folder. */
  onCloneUrl: (url: string, folder: ChosenFolder) => void;
  /** Clones a repository of the account (forking it first when asked) into the chosen folder. */
  onCloneHost: (host: string, repo: RemoteRepo, fork: boolean, folder: ChosenFolder) => void;
  onProfiles: () => void;
  onClose: () => void;
}

type Listing = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; repos: RemoteRepo[]; me: string | null };

const URL_SOURCE: Source = { id: "url", label: "Clone with URL", icon: Globe };

/** Clone by address, or pick from the repositories of the signed-in GitHub or GitLab account. */
export function CloneDialog({ onCloneUrl, onCloneHost, onProfiles, onClose }: Props) {
  const [accounts, setAccounts] = useState<HostAccount[]>([]);
  const [source, setSource] = useState("url");
  const [folder, setFolder] = useState<ChosenFolder | null>(null);
  const [url, setUrl] = useState("");
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const asked = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [fork, setFork] = useState(false);

  useEffect(() => {
    hostAccounts().then(setAccounts, () => undefined);
  }, []);

  const account = accounts.find((a) => a.host === source) ?? null;

  // Each host's repositories are asked for once, the first time its tab is opened.
  useEffect(() => {
    if (!account || !account.signed_in || asked.current.has(account.host)) return;
    asked.current.add(account.host);
    const host = account.host;
    setListings((l) => ({ ...l, [host]: { state: "loading" } }));
    Promise.all([listRemoteRepositories(host), listNamespaces(host).catch(() => [])]).then(
      ([repos, spaces]) =>
        setListings((l) => ({ ...l, [host]: { state: "ready", repos, me: spaces.find((n) => n.personal)?.path ?? null } })),
      (e) => setListings((l) => ({ ...l, [host]: { state: "error", message: String(e).replace(/^Error:\s*/, "") } })),
    );
  }, [account]);

  const listing = account ? listings[account.host] : undefined;
  const repos = listing?.state === "ready" ? listing.repos : [];
  const me = listing?.state === "ready" ? listing.me : null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.full_name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : repos;
  }, [repos, query]);
  const groups = useMemo(() => groupByOwner(shown), [shown]);
  const chosen = repos.find((r) => r.full_name === selected) ?? null;
  const mine = !!chosen && !!me && chosen.owner.toLowerCase() === me.toLowerCase();

  const select = (id: string) => {
    setSource(id);
    setSelected(null);
    setQuery("");
    setFork(false);
  };

  const ready = !!folder && (source === "url" ? url.trim().length > 0 : !!chosen);
  const submit = () => {
    if (!ready || !folder) return;
    if (source === "url") onCloneUrl(url.trim(), folder);
    else if (chosen) onCloneHost(source, chosen, fork && !mine, folder);
  };

  return (
    <Dialog
      title="Clone a repository"
      width={780}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={fork && !mine && source !== "url" ? GitFork : Download} disabled={!ready}>
            {source !== "url" && fork && !mine ? "Fork and clone" : "Clone the repo"}
          </Button>
        </>
      }
    >
      <div className="rail-layout">
        <SourceRail sources={[URL_SOURCE, ...hostSources(accounts)]} active={source} onSelect={select} />
        <div className="rail-main dialog-body">
          <FolderField label="Where to clone to" folder={folder} onChange={setFolder} />

          {source === "url" && (
            <TextField
              label="Repository URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              spellCheck={false}
              hint="Private repositories use the sign-in of the active profile."
            />
          )}

          {account && !account.signed_in && (
            <div className="callout callout-warn" role="note">
              <TriangleAlert size={16} />
              <div>
                <p>Sign in to {hostLabel(account.host)} to see your repositories here.</p>
                <Button type="button" size="sm" onClick={onProfiles}>
                  Manage profiles
                </Button>
              </div>
            </div>
          )}

          {account?.signed_in && (
            <>
              <div className="field">
                <label htmlFor="rp-search">Repository to clone</label>
                <div className="input-wrap has-icon">
                  <Search size={14} />
                  <input
                    id="rp-search"
                    className="input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search remotes"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
              {listing?.state === "loading" && <p className="muted small">Loading your repositories…</p>}
              {listing?.state === "error" && (
                <div className="callout callout-warn" role="alert">
                  <TriangleAlert size={16} />
                  <p>{listing.message}</p>
                </div>
              )}
              {listing?.state === "ready" && (
                <div className="rp-list" role="listbox" aria-label="Repositories">
                  {groups.map((g) => (
                    <div key={g.owner} role="group" aria-label={g.owner}>
                      <div className="rp-group">{g.owner}</div>
                      {g.repos.map((r) => (
                        <button
                          key={r.full_name}
                          type="button"
                          role="option"
                          aria-selected={r.full_name === selected}
                          className={r.full_name === selected ? "rp-item selected" : "rp-item"}
                          title={r.description || r.full_name}
                          onClick={() => setSelected(r.full_name)}
                        >
                          {r.private ? <Lock size={13} /> : <LockOpen size={13} />}
                          <span className="rp-name">{r.name}</span>
                          {r.fork && <GitFork size={12} className="rp-fork" aria-label="a fork" />}
                        </button>
                      ))}
                    </div>
                  ))}
                  {shown.length === 0 && <p className="muted small rp-empty">{repos.length === 0 ? "This account has no repositories yet." : "No repository matches."}</p>}
                </div>
              )}
              {chosen && (
                <label className="check-row">
                  <input type="checkbox" checked={fork && !mine} disabled={mine} onChange={(e) => setFork(e.target.checked)} /> Fork it to my
                  account first, and clone my copy
                </label>
              )}
              {chosen && (
                <p className="muted small">
                  {mine
                    ? "This repository is already yours."
                    : fork
                      ? "Your copy becomes origin and the original is kept as upstream, so you can pull its changes and push your own."
                      : `Clones ${chosen.full_name} as it is on ${hostLabel(source)}.`}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
