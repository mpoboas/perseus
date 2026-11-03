import { useEffect, useState } from "react";
import { type LfsStatus, type LogEntry, type Profile, type ProfilesSnapshot, type RepoInfo, activityLog, lfsStatus, lfsTrack, linksRegistered, registerLinks } from "../ipc";
import { AVATAR_PREF, GRAVATAR_PREF } from "../lib/avatars";
import { absoluteTime, relativeTime } from "../lib/format";
import { LANGUAGES, type LanguagePref, useLanguage, useT } from "../i18n";
import { usePref } from "../lib/prefs";
import { PALETTES, type ThemePref, usePalette } from "../lib/theme";
import { ZOOM_DEFAULT, ZOOM_PREF, ZOOM_STEPS, sanitizeZoom } from "../lib/zoom";
import { Badge, Button, EmptyState } from "../ui";
import { CheckRow, NumberRow, Row, Section, SelectRow, TextRow } from "./fields";
import { KEYS, LARGE_FILE_DEFAULT, pinnedProfileKey, repoKey } from "./keys";

// ---------------------------------------------------------------- General

export function GeneralPage() {
  const [minutes, setMinutes] = usePref<number>(KEYS.autoFetch, 0);
  const [prune, setPrune] = usePref<boolean>(KEYS.autoPrune, false);
  const [branch, setBranch] = usePref<string>(KEYS.defaultBranch, "main");
  const [megabytes, setMegabytes] = usePref<number>(KEYS.largeFile, LARGE_FILE_DEFAULT);

  return (
    <>
      <Section title="Fetching">
        <NumberRow
          label="Auto-fetch interval"
          value={minutes}
          min={0}
          max={60}
          suffix="minutes"
          ariaLabel="Auto-fetch interval in minutes"
          hint="Between 0 and 60 (0 turns it off). Fetches every remote of the open repository while Perseus is in use."
          warn="Each fetch contacts your Git host. It is off by default."
          onChange={setMinutes}
        />
        <CheckRow
          label="Auto-prune"
          checked={prune}
          hint="When fetching, forget remote-tracking branches that no longer exist on the remote."
          onChange={setPrune}
        />
      </Section>

      <Section title="New repositories">
        <TextRow
          label="Default branch name"
          value={branch}
          placeholder="main"
          hint="The first branch of repositories created with “Create a new repository”."
          onChange={setBranch}
        />
      </Section>

      <Section title="Committing">
        <NumberRow
          label="Large file warning"
          value={megabytes}
          min={0}
          max={4096}
          suffix="MB"
          ariaLabel="Large file threshold in megabytes"
          hint="Warn before committing a staged file bigger than this (0 turns it off). Files stay in the history forever once committed, and GitHub refuses files over 100 MB."
          onChange={setMegabytes}
        />
      </Section>

      <Section title="Links">
        <LinksRow />
      </Section>

      <Section title="Your Git configuration">
        <p className="set-note">
          Perseus never edits your global Git configuration. Identity, SSH keys and sign-ins are applied per command from the active
          profile, so options such as <code>core.autocrlf</code> or <code>core.longpaths</code> stay whatever you set them to with{" "}
          <code>git config</code>.
        </p>
      </Section>
    </>
  );
}

/** Whether `perseus-app://` links open this copy of Perseus, and a button to make them. */
function LinksRow() {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    linksRegistered().then(setRegistered, () => setRegistered(null));
  }, []);

  const register = () => {
    setError(null);
    registerLinks().then(
      () => setRegistered(true),
      (e) => setError(String(e)),
    );
  };

  return (
    <Row
      label="Open links in Perseus"
      hint={
        <>
          Links like <code>perseus-app://open?path=…&amp;commit=…</code> (copy one from the command palette or a commit's menu) open the
          repository, and select the commit, in Perseus. A folder Perseus has not opened before asks for your confirmation first.
        </>
      }
      warn={error ? `Could not register: ${error}` : undefined}
    >
      {registered ? <Badge tone="success">Registered</Badge> : <Button onClick={register}>Register for this user</Button>}
    </Row>
  );
}

// ---------------------------------------------------------------- Profiles

export function ProfilesPage({
  profiles,
  onSwitch,
  onManage,
}: {
  profiles: ProfilesSnapshot | null;
  onSwitch: (id: string | null) => void;
  onManage: () => void;
}) {
  const list = profiles?.profiles ?? [];
  return (
    <>
      <p className="set-note">
        A profile is the name and e-mail on your commits, plus an optional SSH key, signing key and sign-ins. Switch the active one from
        the toolbar. Perseus can use as many as you like, and keeps tokens in the operating system's keychain.
      </p>
      <div className="set-table" role="table" aria-label="Profiles">
        <div className="set-tr set-th" role="row">
          <span>Profile</span>
          <span>Author name</span>
          <span>Author e-mail</span>
          <span />
        </div>
        <div className={profiles?.active ? "set-tr" : "set-tr active"} role="row">
          <span>System default</span>
          <span className="muted">from your Git config</span>
          <span className="muted">from your Git config</span>
          {profiles?.active ? (
            <Button size="sm" onClick={() => onSwitch(null)}>
              Use
            </Button>
          ) : (
            <Badge tone="accent">In use</Badge>
          )}
        </div>
        {list.map((p) => (
          <div key={p.id} className={p.id === profiles?.active ? "set-tr active" : "set-tr"} role="row">
            <span>{p.name}</span>
            <span>{p.user_name}</span>
            <span className="muted">{p.user_email}</span>
            {p.id === profiles?.active ? (
              <Badge tone="accent">In use</Badge>
            ) : (
              <Button size="sm" onClick={() => onSwitch(p.id)}>
                Use
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="set-actions">
        <Button variant="primary" onClick={onManage}>
          Manage profiles…
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Integrations

export function IntegrationsPage({ profiles, onManage }: { profiles: ProfilesSnapshot | null; onManage: () => void }) {
  const active = profiles?.profiles.find((p) => p.id === profiles.active);
  const hosts: { host: string; label: string }[] = [
    { host: "github.com", label: "GitHub" },
    { host: "gitlab.com", label: "GitLab" },
  ];
  const others = (active?.credentials ?? []).filter((c) => !hosts.some((h) => h.host === c.host));
  return (
    <>
      <p className="set-note">
        Sign-ins belong to a profile. They are used to fetch, pull and push over HTTPS and to show pull requests, issues and checks.
        {active ? ` Showing the sign-ins of “${active.name}”.` : " Choose a profile to see its sign-ins; without one Perseus uses your system's Git credentials."}
      </p>
      {active && (
        <div className="set-table" role="table" aria-label="Sign-ins">
          <div className="set-tr set-th set-tr-3" role="row">
            <span>Host</span>
            <span>Account</span>
            <span>Status</span>
          </div>
          {[
            ...hosts.map((h) => ({ ...h, cred: active.credentials.find((c) => c.host === h.host) })),
            ...others.map((c) => ({ host: c.host, label: c.host, cred: c })),
          ].map((row) => (
            <div key={row.host} className="set-tr set-tr-3" role="row">
              <span>{row.label}</span>
              <span className={row.cred ? "" : "muted"}>{row.cred ? row.cred.username || "signed in" : "—"}</span>
              <span>
                {row.cred ? (
                  <Badge tone="success">{row.cred.oauth ? "Connected · renews itself" : "Connected · access token"}</Badge>
                ) : (
                  <Badge>Not connected</Badge>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="set-actions">
        <Button variant="primary" onClick={onManage}>
          Sign in or manage…
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Appearance

export function AppearancePage({ theme, onTheme }: { theme: ThemePref; onTheme: (t: ThemePref) => void }) {
  const [labels, setLabels] = usePref<boolean>(KEYS.toolbarLabels, true);
  const [dateStyle, setDateStyle] = usePref<"absolute" | "relative">(KEYS.dateStyle, "absolute");
  const [refs, setRefs] = usePref<boolean>(KEYS.graphRefs, true);
  const [author, setAuthor] = usePref<boolean>(KEYS.graphAuthor, true);
  const [date, setDate] = usePref<boolean>(KEYS.graphDate, true);
  const [ghost, setGhost] = usePref<boolean>(KEYS.graphGhost, true);
  const [bands, setBands] = usePref<boolean>(KEYS.graphBands, true);
  const [diffMode, setDiffMode] = usePref<"unified" | "split">(KEYS.diffMode, "unified");
  const [diffHighlight, setDiffHighlight] = usePref<boolean>(KEYS.diffHighlight, true);
  const [diffWords, setDiffWords] = usePref<boolean>(KEYS.diffWords, true);
  const [pictures, setPictures] = usePref<boolean>(AVATAR_PREF, true);
  const [gravatar, setGravatar] = usePref<boolean>(GRAVATAR_PREF, false);
  const t = useT();
  const [language, setLanguage] = useLanguage();
  const [palette, setPalette] = usePalette();
  const [zoomPref, setZoomPref] = usePref<number>(ZOOM_PREF, ZOOM_DEFAULT);
  const sample = Math.floor(Date.now() / 1000) - 26 * 86400;

  return (
    <>
      <Section>
        <SelectRow
          label={t("appearance.language")}
          value={language}
          options={LANGUAGES.map((l) => ({ value: l.id, label: l.id === "system" ? t("appearance.followSystem") : l.label }))}
          hint={t("appearance.languageHint")}
          onChange={(v: LanguagePref) => setLanguage(v)}
        />
        <SelectRow
          label={t("appearance.theme")}
          value={theme}
          options={[
            { value: "system", label: t("appearance.followSystem") },
            { value: "dark", label: t("appearance.themeDark") },
            { value: "light", label: t("appearance.themeLight") },
          ]}
          onChange={onTheme}
        />
        <SelectRow
          label={t("appearance.colours")}
          value={palette}
          options={PALETTES.map((p) => ({ value: p.id, label: p.label }))}
          hint={t("appearance.coloursHint")}
          onChange={setPalette}
        />
        <SelectRow
          label={t("appearance.zoom")}
          value={String(sanitizeZoom(zoomPref))}
          options={ZOOM_STEPS.map((z) => ({ value: String(z), label: `${z}%` }))}
          hint={t("appearance.zoomHint")}
          onChange={(v) => setZoomPref(Number(v))}
        />
        <CheckRow label={t("appearance.toolbarLabels")} checked={labels} onChange={setLabels} />
      </Section>

      <Section title="Date and time">
        <SelectRow
          label="Show commit dates as"
          value={dateStyle}
          options={[
            { value: "absolute", label: `A date and time (${absoluteTime(sample)})` },
            { value: "relative", label: `How long ago (${relativeTime(sample)})` },
          ]}
          hint="The order of day, month and year follows your system's language."
          onChange={setDateStyle}
        />
      </Section>

      <Section title="Commit graph">
        <CheckRow label="Show branches and tags" checked={refs} onChange={setRefs} />
        <CheckRow label="Show commit author" checked={author} onChange={setAuthor} />
        <CheckRow label="Show commit date/time" checked={date} onChange={setDate} />
        <CheckRow
          label="Show ghost branch when hovering"
          checked={ghost}
          hint="Hovering a commit that has no label shows, faded, the branch it belongs to."
          onChange={setGhost}
        />
        <CheckRow
          label="Colour each commit's row by branch"
          checked={bands}
          hint="A soft band in the branch colour from the avatar to the message."
          onChange={setBands}
        />
      </Section>

      <Section title="Diffs">
        <SelectRow
          label="Show diffs"
          value={diffMode}
          options={[
            { value: "unified", label: "In one column" },
            { value: "split", label: "Side by side" },
          ]}
          hint="You can also switch from the diff's own header."
          onChange={setDiffMode}
        />
        <CheckRow
          label="Colour code by language"
          checked={diffHighlight}
          hint="Keywords, strings, comments and so on, for the common languages and config formats."
          onChange={setDiffHighlight}
        />
        <CheckRow
          label="Mark the words that changed"
          checked={diffWords}
          hint="Inside a removed line and the added line that replaces it."
          onChange={setDiffWords}
        />
      </Section>

      <Section title="Profile pictures">
        <CheckRow
          label="Show GitHub pictures"
          checked={pictures}
          hint="For repositories on github.com, the picture of the GitHub account linked to each commit, and your own signed-in account. Turn it off to keep every request to your Git host and show initials instead."
          onChange={setPictures}
        />
        <CheckRow
          label="Also look people up on Gravatar"
          checked={gravatar}
          disabled={!pictures}
          warn="Sends a hash of each author's e-mail address to gravatar.com. Off by default; restart Perseus to apply to people already looked up."
          hint="Covers people GitHub does not know."
          onChange={setGravatar}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- This repository

export function NoRepository() {
  return <EmptyState title="No repository open" hint="Open a repository to change the settings that belong to it." />;
}

export function IdentityPage({
  repo,
  profiles,
  onSwitch,
}: {
  repo: RepoInfo;
  profiles: ProfilesSnapshot | null;
  onSwitch: (id: string | null) => void;
}) {
  const [pinned, setPinned] = usePref<string>(pinnedProfileKey(repo.path), "");
  const list: Profile[] = profiles?.profiles ?? [];
  const valid = list.some((p) => p.id === pinned) ? pinned : "";
  return (
    <>
      <p className="set-note">
        Which profile Perseus uses for <strong>{repo.name}</strong>. Pinning one means opening this repository always switches to it.
        Without a pin, the profile's automatic rules (such as <code>github.com/acme/*</code>) decide.
      </p>
      <Section>
        <SelectRow
          label="Profile for this repository"
          value={valid}
          options={[{ value: "", label: "Decide automatically" }, ...list.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(id) => {
            setPinned(id);
            if (id) onSwitch(id);
          }}
        />
      </Section>
    </>
  );
}

export function CommitPage({ repo }: { repo: RepoInfo }) {
  const [push, setPush] = usePref<boolean>(repoKey(repo.path, "pushAfterCommit"), false);
  const [skip, setSkip] = usePref<boolean>(repoKey(repo.path, "skipHooks"), false);
  return (
    <>
      <Section>
        <CheckRow
          label="Push after each commit"
          checked={push}
          hint="Pushes the branch right after a commit succeeds (only when it has an upstream)."
          onChange={setPush}
        />
        <CheckRow
          label="Skip git hooks by default"
          checked={skip}
          hint="Starts the “Skip commit hooks” box in the Changes tab ticked. Hooks are the scripts in the repository's hooks folder; you can still change it for a single commit."
          onChange={setSkip}
        />
      </Section>
      <p className="set-note">A commit template set in this repository's Git configuration (<code>commit.template</code>) pre-fills the message box on its own.</p>
    </>
  );
}

export function LfsPage({ repo }: { repo: RepoInfo }) {
  const [status, setStatus] = useState<LfsStatus | null>(null);
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => void lfsStatus(repo.id).then(setStatus, () => setStatus(null));
  useEffect(load, [repo.id]);

  const add = async () => {
    setError(null);
    try {
      await lfsTrack(repo.id, pattern.trim());
      setPattern("");
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!status) return <p className="set-note">Reading…</p>;
  return (
    <>
      <Section title="Tracked patterns">
        {status.patterns.length === 0 ? (
          <p className="set-note">Nothing is stored through Git LFS in this repository yet.</p>
        ) : (
          <ul className="set-list">
            {status.patterns.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {status.installed ? (
        <Section title="Track a new pattern">
          <Row label="Pattern" hint="For example *.psd. Perseus adds it to .gitattributes; commit that file to share it.">
            <div className="set-inline">
              <input
                className="input set-text"
                value={pattern}
                placeholder="*.psd"
                spellCheck={false}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pattern.trim() && void add()}
              />
              <Button disabled={!pattern.trim()} onClick={() => void add()}>
                Track
              </Button>
            </div>
            {error && <p className="set-warn">{error}</p>}
          </Row>
        </Section>
      ) : (
        <p className="set-note">Git LFS is not installed on this computer, so patterns cannot be tracked from here.</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Activity log

const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour12: false });

export function ActivityPage() {
  const [reads, setReads] = usePref<boolean>(KEYS.showReads, false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const reload = () => void activityLog().then(setLog, () => setLog([]));
  useEffect(reload, []);
  const shown = log.filter((e) => reads || !e.read_only).slice(-200).reverse();

  return (
    <>
      <p className="set-note">
        Every git command Perseus ran for you, newest first. Passwords inside URLs are hidden. The log lives in memory only and nothing
        leaves your computer.
      </p>
      <div className="set-actions set-actions-start">
        <label className="set-check">
          <input type="checkbox" checked={reads} onChange={(e) => setReads(e.target.checked)} />
          <span>Use extended logging (include commands that only read)</span>
        </label>
        <Button size="sm" variant="ghost" onClick={reload}>
          Refresh
        </Button>
      </div>
      <ol className="activity-log selectable" aria-label="Git commands">
        {shown.length === 0 && <li className="muted">Nothing yet</li>}
        {shown.map((e, i) => (
          <li key={`${e.time}-${i}`} className={e.ok ? "" : "failed"}>
            <time>{clock(e.time)}</time>
            <code>{e.command}</code>
            <span className="muted">{e.millis} ms</span>
            {e.error && <em>{e.error}</em>}
          </li>
        ))}
      </ol>
    </>
  );
}

