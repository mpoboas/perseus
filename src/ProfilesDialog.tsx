import { useEffect, useState } from "react";
import {
  type Profile,
  type ProfilesSnapshot,
  deleteProfile,
  pickSshKey,
  removeCredential,
  saveProfile,
  setCredential,
} from "./ipc";

interface Props {
  snapshot: ProfilesSnapshot;
  /** Called after any change so the parent can reload the snapshot. */
  onChanged: () => Promise<void>;
  onClose: () => void;
}

interface Form {
  name: string;
  user_name: string;
  user_email: string;
  ssh_key: string;
}

const EMPTY: Form = { name: "", user_name: "", user_email: "", ssh_key: "" };

const toForm = (p: Profile): Form => ({
  name: p.name,
  user_name: p.user_name,
  user_email: p.user_email,
  ssh_key: p.ssh_key ?? "",
});

export function ProfilesDialog({ snapshot, onChanged, onClose }: Props) {
  // `null` = editing a profile that has not been saved yet.
  const [selected, setSelected] = useState<string | null>(snapshot.profiles[0]?.id ?? null);
  const profile = snapshot.profiles.find((p) => p.id === selected) ?? null;
  const [form, setForm] = useState<Form>(profile ? toForm(profile) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [host, setHost] = useState("github.com");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    setForm(profile ? toForm(profile) : EMPTY);
    setError(null);
    setToken("");
    // Only re-seed the form when switching profiles, not on every snapshot refresh.
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const saved = await saveProfile({
        id: profile?.id ?? null,
        name: form.name,
        user_name: form.user_name,
        user_email: form.user_email,
        ssh_key: form.ssh_key.trim() || null,
      });
      // Refresh first: selecting before the new snapshot arrives would re-seed an empty form.
      await onChanged();
      setSelected(saved.id);
    });

  const remove = () =>
    profile &&
    run(async () => {
      await deleteProfile(profile.id);
      await onChanged();
      setSelected(snapshot.profiles.find((p) => p.id !== profile.id)?.id ?? null);
    });

  const browse = async () => {
    try {
      const picked = await pickSshKey();
      if (picked) setForm((f) => ({ ...f, ssh_key: picked }));
    } catch (e) {
      setError(String(e));
    }
  };

  const addToken = () =>
    profile &&
    run(async () => {
      await setCredential(profile.id, host, username || form.user_name, token);
      setToken(""); // never keep a secret in UI state longer than needed
    });

  const field = (label: string, key: keyof Form, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Profiles">
        <header className="modal-head">
          <h2>Profiles</h2>
          <button className="mini" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <nav className="profile-list">
            {snapshot.profiles.map((p) => (
              <button
                key={p.id}
                className={p.id === selected ? "profile-item active" : "profile-item"}
                onClick={() => setSelected(p.id)}
              >
                {p.name}
                {p.id === snapshot.active && <span className="badge">active</span>}
              </button>
            ))}
            <button
              className={selected === null ? "profile-item active" : "profile-item"}
              onClick={() => setSelected(null)}
            >
              + New profile
            </button>
          </nav>

          <section className="profile-form">
            {field("Profile name", "name", { placeholder: "Work", maxLength: 64 })}
            {field("Commit name", "user_name", { placeholder: "Ada Lovelace", maxLength: 100 })}
            {field("Commit email", "user_email", { placeholder: "ada@example.com", maxLength: 254 })}
            <label className="field">
              <span>SSH key (optional)</span>
              <div className="field-row">
                <input
                  value={form.ssh_key}
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(e) => setForm({ ...form, ssh_key: e.target.value })}
                />
                <button type="button" disabled={busy} onClick={browse}>
                  Browse…
                </button>
              </div>
              <small className="muted">
                Only this key is offered for SSH remotes. Use a key without a passphrase, or one
                already loaded in your agent.
              </small>
            </label>

            <div className="form-actions">
              <button disabled={busy} onClick={save}>
                {profile ? "Save changes" : "Create profile"}
              </button>
              {profile && (
                <button disabled={busy} className="danger" onClick={remove}>
                  Delete profile
                </button>
              )}
            </div>

            {profile && (
              <section className="tokens">
                <h3>Access tokens for HTTPS</h3>
                <p className="muted">
                  Stored in your operating system's keychain, never in Perseus's files. Pushes and
                  pulls over HTTPS use only the active profile's tokens.
                </p>
                {!snapshot.helper_available && profile.credentials.length > 0 && (
                  <p className="warn">
                    The credential helper was not found next to the app, so these tokens cannot be
                    used yet. Build it with <code>cargo build -p perseus-credential-helper</code>.
                  </p>
                )}
                <ul className="token-list">
                  {profile.credentials.map((c) => (
                    <li key={c.host}>
                      <span className="token-host">{c.host}</span>
                      <span className="muted">{c.username}</span>
                      <button
                        className="mini"
                        disabled={busy}
                        onClick={() => run(() => removeCredential(profile.id, c.host))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                  {profile.credentials.length === 0 && <li className="muted">No tokens yet</li>}
                </ul>
                <form
                  className="token-form"
                  autoComplete="off"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addToken();
                  }}
                >
                  <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" />
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={form.user_name || "username"}
                  />
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Personal access token"
                    autoComplete="new-password"
                  />
                  <button type="submit" disabled={busy || !token}>
                    Save token
                  </button>
                </form>
              </section>
            )}

            {error && <p className="error-text">{error}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
