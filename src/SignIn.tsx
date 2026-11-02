import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, LogIn } from "lucide-react";
import {
  type OAuthKind,
  type OAuthPreset,
  type Profile,
  type SignInCode,
  oauthCancel,
  oauthPresets,
  oauthSignIn,
} from "./ipc";
import { Button, Spinner } from "./ui";

interface Props {
  profile: Profile;
  /** Called after a token has been stored, so the caller can reload profiles. */
  onSignedIn: () => Promise<void>;
  onError: (message: string) => void;
}

/** "Sign in with GitHub / GitLab" using the device flow: the user types a short code on the provider's page. */
export function SignIn({ profile, onSignedIn, onError }: Props) {
  const [presets, setPresets] = useState<OAuthPreset[]>([]);
  const [kind, setKind] = useState<OAuthKind>("github");
  const [host, setHost] = useState("github.com");
  const [clientId, setClientId] = useState("");
  const [flow, setFlow] = useState<{ id: number; code: SignInCode | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const activeFlow = useRef<number | null>(null);

  useEffect(() => {
    oauthPresets().then(setPresets, (e) => onError(String(e)));
    // Leaving the dialog mid-sign-in must not leave a poller running.
    return () => {
      if (activeFlow.current !== null) void oauthCancel(activeFlow.current);
    };
  }, [onError]);

  const preset = presets.find((p) => p.kind === kind);
  // A built-in client ID only covers the provider's main host; anything else needs its own app.
  const builtIn = !!preset?.configured && host.trim().toLowerCase() === preset.host;

  const changeKind = (next: OAuthKind) => {
    setKind(next);
    setHost(presets.find((p) => p.kind === next)?.host ?? "");
    setClientId("");
  };

  const start = async () => {
    const { flowId, done } = oauthSignIn(
      {
        profile_id: profile.id,
        kind,
        host: host.trim(),
        client_id: builtIn ? null : clientId.trim() || null,
      },
      (code) => setFlow((f) => (f ? { ...f, code } : f)),
    );
    activeFlow.current = flowId;
    setFlow({ id: flowId, code: null });
    setCopied(false);
    try {
      await done;
      await onSignedIn();
    } catch (e) {
      onError(String(e));
    } finally {
      activeFlow.current = null;
      setFlow(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard unavailable: the code is on screen anyway */
    }
  };

  if (flow) {
    return (
      <div className="signin waiting" aria-live="polite">
        {flow.code ? (
          <>
            <p>
              {flow.code.opened
                ? "A browser page was opened. Enter this code there to approve:"
                : "Open this page in your browser and enter the code:"}
            </p>
            <div className="device-code">
              <code className="selectable">{flow.code.user_code}</code>
              <Button
                size="sm"
                icon={copied ? Check : Copy}
                onClick={() => void copy(flow.code!.user_code)}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="muted small">
              <ExternalLink size={12} /> {flow.code.verification_uri}
            </p>
            <p className="muted small">
              <Spinner size={12} /> Waiting for you to approve…
            </p>
          </>
        ) : (
          <p className="muted">
            <Spinner size={12} /> Contacting {host}…
          </p>
        )}
        <Button onClick={() => void oauthCancel(flow.id)}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className="signin">
      <div className="signin-row">
        <select
          className="select"
          value={kind}
          onChange={(e) => changeKind(e.target.value as OAuthKind)}
          aria-label="Provider"
        >
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
        </select>
        <input
          className="input"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={kind === "github" ? "github.com" : "gitlab.com"}
          aria-label="Host"
        />
        <Button
          variant="primary"
          icon={LogIn}
          onClick={() => void start()}
          disabled={!host.trim() || (!builtIn && !clientId.trim())}
        >
          Sign in
        </Button>
      </div>
      {!builtIn && (
        <input
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="OAuth app client ID (from your app's settings on this host)"
          aria-label="Client ID"
        />
      )}
      <p className="muted small">
        You approve on {kind === "github" ? "GitHub" : "GitLab"}&apos;s own page by entering a short code. Perseus
        never sees your password.
      </p>
    </div>
  );
}
