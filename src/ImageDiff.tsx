import { useEffect, useState } from "react";
import { FileImage, TriangleAlert } from "lucide-react";
import { type DiffTarget, fetchBlob } from "./ipc";
import { imageType } from "./lib/images";
import { EmptyState, Segmented, Skeleton } from "./ui";

interface Side {
  rev: string;
  path: string;
}

/** Where the "before" and "after" of a file live for each kind of diff (null: that side does not exist). */
export function imageSides(t: DiffTarget): { before: Side | null; after: Side | null } {
  if (t.kind === "commit") {
    return { before: { rev: `${t.oid}^`, path: t.orig ?? t.path }, after: { rev: t.oid, path: t.path } };
  }
  if (t.side === "staged") return { before: { rev: "head", path: t.orig ?? t.path }, after: { rev: "index", path: t.path } };
  if (t.side === "unstaged") return { before: { rev: "index", path: t.path }, after: { rev: "work", path: t.path } };
  return { before: null, after: { rev: "work", path: t.path } };
}

interface Loaded {
  url: string;
  size: number;
  truncated: boolean;
}

type Slot = "loading" | "none" | Loaded | { error: string };

function useSide(repoId: number, side: Side | null, version: number): Slot {
  const [slot, setSlot] = useState<Slot>(side ? "loading" : "none");
  const key = side ? `${side.rev}:${side.path}` : "";
  useEffect(() => {
    if (!side) {
      setSlot("none");
      return;
    }
    const ctl = new AbortController();
    let url: string | null = null;
    setSlot("loading");
    fetchBlob(repoId, side.path, side.rev, ctl.signal).then(
      (file) => {
        if (!file) return setSlot("none");
        if (file.truncated) return setSlot({ url: "", size: file.bytes.byteLength, truncated: true });
        url = URL.createObjectURL(new Blob([file.bytes], { type: imageType(side.path) ?? "application/octet-stream" }));
        setSlot({ url, size: file.bytes.byteLength, truncated: false });
      },
      (e) => !ctl.signal.aborted && setSlot({ error: String(e) }),
    );
    return () => {
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
    // `key` stands for `side`, which is a fresh object on every render.
  }, [repoId, key, version]);
  return slot;
}

const kib = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

type View = "side" | "swipe";

interface Dims {
  w: number;
  h: number;
}

/** Icons and other tiny pictures are blown up in whole pixels, so they can be seen. */
function smallScale(d: Dims | undefined): React.CSSProperties | undefined {
  if (!d || Math.max(d.w, d.h) >= 96) return undefined;
  const k = Math.floor(160 / Math.max(d.w, d.h, 1));
  return { width: d.w * k, height: d.h * k, imageRendering: "pixelated" };
}

/** Before and after of a picture, side by side or with a slider to wipe one over the other. */
export function ImageDiff({ repoId, target, version }: { repoId: number; target: DiffTarget; version: number }) {
  const { before, after } = imageSides(target);
  const was = useSide(repoId, before, version);
  const now = useSide(repoId, after, version);
  const [view, setView] = useState<View>("side");
  const [dims, setDims] = useState<{ before?: Dims; after?: Dims }>({});
  const [swipe, setSwipe] = useState(50);

  useEffect(() => setDims({}), [target.path, version]);

  if (was === "loading" || now === "loading") {
    return (
      <div className="diff-skeleton">
        <Skeleton width="40%" height={140} />
      </div>
    );
  }
  const failure = [was, now].find((s): s is { error: string } => typeof s === "object" && "error" in s);
  if (failure) return <EmptyState icon={TriangleAlert} title="Could not load this picture" hint={failure.error} />;
  if (was === "none" && now === "none") return <EmptyState icon={FileImage} title="No picture to show" hint="This version of the file is empty or missing." />;

  const pane = (label: string, slot: Slot, which: "before" | "after", tone: string) => {
    if (slot === "none") return <div className={`img-pane none ${tone}`}><span className="img-label">{label}</span><span className="muted">{which === "before" ? "Added in this change" : "Removed in this change"}</span></div>;
    const loaded = slot as Loaded;
    return (
      <div className={`img-pane ${tone}`}>
        <span className="img-label">
          {label}
          <span className="img-meta">
            {dims[which] ? `${dims[which]!.w}×${dims[which]!.h} · ` : ""}
            {kib(loaded.size)}
          </span>
        </span>
        {loaded.truncated ? (
          <span className="muted">Too large to preview ({kib(loaded.size)}+)</span>
        ) : (
          <img
            className="img-shot"
            src={loaded.url}
            alt={`${label} version of ${target.path}`}
            style={smallScale(dims[which])}
            onLoad={(e) => {
              // Read the size now: the event's target is gone by the time a state updater runs.
              const size = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
              setDims((d) => ({ ...d, [which]: size }));
            }}
          />
        )}
      </div>
    );
  };

  const both = was !== "none" && now !== "none" && !(was as Loaded).truncated && !(now as Loaded).truncated;
  return (
    <div className="img-diff">
      {both && (
        <div className="img-bar">
          <Segmented<View>
            label="Picture comparison"
            value={view}
            onChange={setView}
            options={[
              { value: "side", label: "Side by side" },
              { value: "swipe", label: "Swipe" },
            ]}
          />
          {view === "swipe" && (
            <input
              type="range"
              className="img-slider"
              min={0}
              max={100}
              value={swipe}
              aria-label="How much of the new version to show"
              onChange={(e) => setSwipe(Number(e.target.value))}
            />
          )}
        </div>
      )}
      {both && view === "swipe" ? (
        <div className="img-swipe">
          <img className="img-shot under" src={(was as Loaded).url} alt={`Before version of ${target.path}`} />
          <img
            className="img-shot over"
            src={(now as Loaded).url}
            alt={`After version of ${target.path}`}
            style={{ clipPath: `inset(0 ${100 - swipe}% 0 0)` }}
          />
        </div>
      ) : (
        <div className="img-panes">
          {pane("Before", was, "before", "del")}
          {pane("After", now, "after", "add")}
        </div>
      )}
    </div>
  );
}
