import { useState } from "react";
import { KeyRound, ShieldQuestion } from "lucide-react";
import type { Question } from "./ipc";
import { Button, Dialog } from "./ui";

interface Props {
  question: Question;
  /** `null` cancels: git or ssh then fails with a clear message instead of waiting. */
  onAnswer: (answer: string | null) => void;
}

/** A question from git or ssh: a password, a passphrase, a user name, or "trust this host?". */
export function AskpassDialog({ question, onAnswer }: Props) {
  const [value, setValue] = useState("");
  const confirm = question.kind === "confirm";
  const secret = question.kind === "secret";

  return (
    <Dialog
      title={confirm ? "Do you trust this host?" : secret ? "Password needed" : "Git is asking"}
      width={520}
      onClose={() => onAnswer(null)}
      onSubmit={() => onAnswer(confirm ? "yes" : value)}
      footer={
        confirm ? (
          <>
            <Button type="button" variant="ghost" onClick={() => onAnswer("no")} data-autofocus="">
              Do not trust
            </Button>
            <Button type="button" variant="primary" icon={ShieldQuestion} onClick={() => onAnswer("yes")}>
              Trust and continue
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={() => onAnswer(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon={KeyRound}>
              Continue
            </Button>
          </>
        )
      }
    >
      <div className="dialog-body">
        <pre className="ask-prompt selectable">{question.prompt.trim()}</pre>
        {confirm ? (
          <p className="muted small">
            Only continue if the fingerprint above is the one your provider publishes. Trusting an unknown host lets it
            receive your code.
          </p>
        ) : (
          <>
            <input
              className="input"
              aria-label={question.prompt.trim().slice(0, 80)}
              type={secret ? "password" : "text"}
              autoComplete={secret ? "new-password" : "off"}
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            {secret && (
              <p className="muted small">
                What you type goes straight to git and is not stored by Perseus. To keep a token, add it to a profile instead.
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
