/** Small formatting helpers shared by the canvas renderer and the DOM panels. */

export function relativeTime(seconds: number, now = Date.now()): string {
  const d = now / 1000 - seconds;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.round(d / (86400 * 30))}mo ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** `07/10/2026 @ 14:37` in the user's own date order; the 24-hour clock keeps it short. */
export function absoluteTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const day = d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} @ ${time}`;
}

/** "Ada Lovelace" → "AL", "grace" → "G". Always uppercase, at most two letters. */
export function initials(name: string): string {
  const words = name
    .replace(/<.*>/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Stable 0-359 hue for a string, so the same person always gets the same avatar color. */
export function hueOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export function avatarColor(name: string): string {
  return `hsl(${hueOf(name.toLowerCase())} 52% 46%)`;
}

export const shortSha = (oid: string) => oid.slice(0, 7);

/** Splits a path into its folder (with trailing slash, or "") and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
