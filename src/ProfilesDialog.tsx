import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, User } from "lucide-react";
import {
  type Profile,
  type ProfilesSnapshot,
  deleteProfile,
  generateSshKey,
  pickSshKey,
  removeCredential,
  saveProfile,
  setCredential,
} from "./ipc";
import { SignIn } from "./SignIn";
import { readPref, writePref } from "./lib/prefs";
import type { ProfileRule } from "./lib/profileRules";
import { Avatar, Badge, Button, Dialog, TextField, useToast } from "./ui";

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
  signing_format: string;
  signing_key: string;
}

const EMPTY: Form = { name: "", user_name: "", user_email: "", ssh_key: "", signing_format: "", signing_key: "" };

const toForm = (p: Profile): Form => ({
  name: p.name,
  user_name: p.user_name,
  user_email: p.user_email,
  ssh_key: p.ssh_key ?? "",
  signing_format: p.signing_format ?? "",
  signing_key: p.signing_key ?? "",
});

/** Where the profile-switching rules (see `lib/profileRules.ts`) are remembered. */
export const RULES_KEY = "profileRules";

export function ProfilesDialog({ snapshot, onChanged, onClose }: Props) {
  const toast = useToast();
  const [rules, setRules] = useState<ProfileRule[]>(() => readPref<ProfileRule[]>(RULES_KEY, []));
  const [newRule, setNewRule] = useState({ pattern: "", profileId: "" });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const saveRules = (next: ProfileRule[]) => {
    setRules(next);
    writePref(RULES_KEY, next);
  };
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
        signing_format: form.signing_format || null,
        signing_key: form.signing_format ? form.signing_key.trim() || null : null,
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

  /** Makes a new SSH key for signing and fills it into the form (the profile still needs saving). */
  const makeKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = await generateSshKey(form.name || form.user_name || "profile", `${form.user_email} (Perseus)`);
      setForm((f) => ({ ...f, signing_format: "ssh", signing_key: key.path }));
      setPublicKey(key.public_key);
      toast.success("Created an SSH key", "Save the profile, then add the public key to your provider.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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

          <div className="field">
            <label htmlFor="sign-format">Sign commits</label>
            <div className="field-row">
              <select
                id="sign-format"
                className="select signing-format"
                value={form.signing_format}
                onChange={(e) => setForm({ ...form, signing_format: e.target.value })}
              >
                <option value="">Do not sign</option>
                <option value="ssh">With an SSH key</option>
                <option value="gpg">With a GPG key</option>
              </select>
              {form.signing_format && (
                <input
                  className="input"
                  aria-label="Signing key"
                  value={form.signing_key}
                  placeholder={form.signing_format === "ssh" ? "Path to the key file" : "GPG key id"}
                  onChange={(e) => setForm({ ...form, signing_key: e.target.value })}
                />
              )}
              {form.signing_format === "ssh" && (
                <Button type="button" disabled={busy} onClick={() => void makeKey()}>
                  Generate key
                </Button>
              )}
            </div>
            {publicKey && (
              <small className="selectable">
                Public key (add it to GitHub or GitLab as a signing key): <code>{publicKey}</code>
              </small>
            )}
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

          <section className="rules">
            <h3>Automatic switching</h3>
            <p className="muted small">
              When a repository&apos;s remote matches a pattern, Perseus switches to that profile as you open it. Use{" "}
              <code>*</code> as a wildcard, for example <code>github.com/acme/*</code>.
            </p>
            <ul className="token-list">
              {rules.map((r, i) => (
                <li key={`${r.pattern}-${i}`}>
                  <code>{r.pattern}</code>
                  <span className="muted">→ {snapshot.profiles.find((p) => p.id === r.profileId)?.name ?? "(deleted profile)"}</span>
                  <span className="grow" />
                  <Button size="sm" variant="ghost" onClick={() => saveRules(rules.filter((_, k) => k !== i))}>
                    Remove
                  </Button>
                </li>
              ))}
              {rules.length === 0 && <li className="muted">No rules yet</li>}
            </ul>
            <div className="rule-add">
              <input
                className="input"
                aria-label="Remote pattern"
                placeholder="github.com/acme/*"
                value={newRule.pattern}
                onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
              />
              <select
                className="select"
                aria-label="Profile for this pattern"
                value={newRule.profileId}
                onChange={(e) => setNewRule({ ...newRule, profileId: e.target.value })}
              >
                <option value="">Choose a profile…</option>
                {snapshot.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={!newRule.pattern.trim() || !newRule.profileId}
                onClick={() => {
                  saveRules([...rules, { pattern: newRule.pattern.trim(), profileId: newRule.profileId }]);
                  setNewRule({ pattern: "", profileId: "" });
                }}
              >
                Add rule
              </Button>
            </div>
          </section>

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
