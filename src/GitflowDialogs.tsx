import { useState } from "react";
import { GitBranchPlus, GitMerge } from "lucide-react";
import type { FlowConfig, FlowFinishOptions, FlowKind } from "./ipc";
import { Button, Dialog, TextField } from "./ui";

export const FLOW_LABEL: Record<FlowKind, string> = {
  feature: "feature",
  release: "release",
  hotfix: "hotfix",
};

const ABOUT: Record<FlowKind, string> = {
  feature: "A feature branch starts from the develop branch and is merged back into it when it is finished.",
  release: "A release branch starts from develop to polish a version. Finishing it merges it into the main branch, tags the version, and merges it back into develop.",
  hotfix: "A hotfix branch starts from the main branch to fix a released version quickly. Finishing it merges it into main and develop, and tags the fix.",
};

/** Names the branches Gitflow uses, the same settings `git flow init` records. */
export function FlowInitDialog({
  initial,
  onInit,
  onClose,
}: {
  initial: FlowConfig;
  onInit: (config: FlowConfig) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState(initial);
  const set = (key: keyof FlowConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg((c) => ({ ...c, [key]: e.target.value.trim() }));
  const ready = cfg.main !== "" && cfg.develop !== "" && [cfg.feature, cfg.release, cfg.hotfix].every((p) => p.endsWith("/"));
  return (
    <Dialog
      title="Set up Gitflow"
      width={500}
      onClose={onClose}
      onSubmit={() => ready && onInit(cfg)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitMerge} disabled={!ready}>
            Set up Gitflow
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">
          Gitflow keeps released code on one branch and ongoing work on another, with short-lived
          feature, release and hotfix branches in between. The develop branch is created if it does not exist.
          The settings are stored in this repository, the same way the <code>git flow</code> tool does.
        </p>
        <TextField label="Main branch (released code)" value={cfg.main} onChange={set("main")} />
        <TextField label="Develop branch (ongoing work)" value={cfg.develop} onChange={set("develop")} />
        <div className="flow-prefixes">
          <TextField label="Feature prefix" value={cfg.feature} onChange={set("feature")} />
          <TextField label="Release prefix" value={cfg.release} onChange={set("release")} />
          <TextField label="Hotfix prefix" value={cfg.hotfix} onChange={set("hotfix")} />
          <TextField label="Version tag prefix" value={cfg.tag_prefix} onChange={set("tag_prefix")} placeholder="v (optional)" />
        </div>
        {!ready && <p className="muted small">Branch prefixes end with a slash, like feature/.</p>}
      </div>
    </Dialog>
  );
}

export function FlowStartDialog({
  kind,
  onStart,
  onClose,
}: {
  kind: FlowKind;
  onStart: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const clean = name.trim();
  return (
    <Dialog
      title={`Start a ${FLOW_LABEL[kind]}`}
      width={460}
      onClose={onClose}
      onSubmit={() => clean && onStart(clean)}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitBranchPlus} disabled={clean === "" || /\s/.test(clean)}>
            Start {FLOW_LABEL[kind]}
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">{ABOUT[kind]}</p>
        <TextField
          label={kind === "feature" ? "Feature name" : "Version"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === "feature" ? "login-page" : "1.2.0"}
        />
      </div>
    </Dialog>
  );
}

export function FlowFinishDialog({
  kind,
  name,
  onFinish,
  onClose,
}: {
  kind: FlowKind;
  name: string;
  onFinish: (options: FlowFinishOptions) => void;
  onClose: () => void;
}) {
  const [keep, setKeep] = useState(false);
  const [squash, setSquash] = useState(false);
  const [tag, setTag] = useState("");
  return (
    <Dialog
      title={`Finish ${FLOW_LABEL[kind]} ${name}`}
      width={480}
      onClose={onClose}
      onSubmit={() => onFinish({ keep_branch: keep, squash: kind === "feature" && squash, tag_message: tag.trim() || null })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={GitMerge}>
            Finish {FLOW_LABEL[kind]}
          </Button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="lede">{ABOUT[kind]}</p>
        {kind !== "feature" && (
          <TextField label="Tag message (optional)" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={`${kind === "release" ? "Release" : "Hotfix"} ${name}`} />
        )}
        {kind === "feature" && (
          <label className="check-row">
            <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} /> Squash its commits into one
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the branch afterwards
        </label>
        <p className="muted small">
          If a merge stops on conflicts, resolve them and continue, then finish again: the steps already done are skipped.
        </p>
      </div>
    </Dialog>
  );
}
