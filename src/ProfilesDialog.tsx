import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, User } from "lucide-react";
import {
  type Profile,
  type ProfilesSnapshot,
  deleteProfile,
  pickSshKey,
  removeCredential,
  saveProfile,
  setCredential,
} from "./ipc";
import { SignIn } from "./SignIn";
import { Avatar, Badge, Button, Dialog, TextField } from "./ui";

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
    <TextField
      label={label}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      {...props}
    />
  );

  return (
    <Dialog title="Profiles" width={820} onClose={onClose}>
      <div className="profiles">
        <nav className="profile-list" aria-label="Profiles">
          {snapshot.profiles.map((p) => (
            <button
              key={p.id}
              className={p.id === selected ? "profile-item active" : "profile-item"}
              onClick={() => setSelected(p.id)}
            >
              <Avatar name={p.user_name || p.name} size={26} />
              <span className="profile-item-text">
                <strong>{p.name}</strong>
                <span>{p.user_email}</span>
              </span>
              {p.id === snapshot.active && <Badge tone="success">active</Badge>}
            </button>
          ))}
          <button
            className={selected === null ? "profile-item active" : "profile-item"}
            onClick={() => setSelected(null)}
          >
            <span className="profile-add">
              <Plus size={14} />
            </span>
            <span className="profile-item-text">
              <strong>New profile</strong>
            </span>
          </button>
        </nav>

        <section className="profile-form">
          <div className="form-grid">
            {field("Profile name", "name", { placeholder: "Work", maxLength: 64 })}
            {field("Commit name", "user_name", { placeholder: "Ada Lovelace", maxLength: 100 })}
            {field("Commit email", "user_email", { placeholder: "ada@example.com", maxLength: 254 })}
            <div className="field">
              <label htmlFor="ssh-key">SSH key (optional)</label>
              <div className="field-row">
                <input
                  id="ssh-key"
                  className="input"
                  value={form.ssh_key}
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(e) => setForm({ ...form, ssh_key: e.target.value })}
                />
                <Button type="button" disabled={busy} onClick={browse}>
                  Browse…
                </Button>
              </div>
              <small>
                Only this key is offered for SSH remotes. Use a key without a passphrase, or one already loaded in
                your agent.
              </small>
            </div>
          </div>

          <div className="form-actions">
            <Button variant="primary" disabled={busy} onClick={save} icon={User}>
              {profile ? "Save changes" : "Create profile"}
            </Button>
            {profile && (
              <Button variant="danger" disabled={busy} onClick={remove} icon={Trash2}>
                Delete profile
              </Button>
            )}
          </div>

          {profile && (
            <section className="tokens">
              <h3>
                <KeyRound size={14} /> Access for HTTPS remotes
              </h3>
              <p className="muted">
                Stored in your operating system&apos;s keychain, never in Perseus&apos;s files. Pushes and pulls over
                HTTPS use only the active profile&apos;s tokens.
              </p>
              {!snapshot.helper_available && profile.credentials.length > 0 && (
                <div className="callout callout-warn">
                  <p>
                    The credential helper was not found next to the app, so these tokens cannot be used yet. Build it
                    with <code>cargo build -p perseus-credential-helper</code>.
                  </p>
                </div>
              )}
              <h4 className="subhead">Sign in with a provider</h4>
              <SignIn profile={profile} onSignedIn={onChanged} onError={setError} />
              <h4 className="subhead">Saved tokens</h4>
              <ul className="token-list">
                {profile.credentials.map((c) => (
                  <li key={c.host}>
                    <span className="token-host">{c.host}</span>
                    <span className="muted">{c.username}</span>
                    {c.oauth && <Badge tone="accent">OAuth</Badge>}
                    <span className="grow" />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => run(() => removeCredential(profile.id, c.host))}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
                {profile.credentials.length === 0 && <li className="muted">No tokens yet</li>}
              </ul>
              <h4 className="subhead">Or paste a token</h4>
              <form
                className="token-form"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addToken();
                }}
              >
                <input
                  className="input"
                  aria-label="Host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="github.com"
                />
                <input
                  className="input"
                  aria-label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={form.user_name || "username"}
                />
                <input
                  className="input"
                  aria-label="Personal access token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Personal access token"
                  autoComplete="new-password"
                />
                <Button type="submit" disabled={busy || !token}>
                  Save token
                </Button>
              </form>
            </section>
          )}

          {error && (
            <div className="callout callout-error" role="alert">
              <p className="selectable">{error}</p>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
