/** Matching a repository's remotes against the profile-switching rules. */

export interface ProfileRule {
  pattern: string;
  profileId: string;
}

/** `https://user@github.com/acme/app.git`, `git@github.com:acme/app.git` → `github.com/acme/app`. */
export function remoteKey(url: string): string | null {
  const trimmed = url.trim();
  let rest: string;
  const scheme = trimmed.indexOf("://");
  if (scheme >= 0) {
    rest = trimmed.slice(scheme + 3);
    rest = rest.slice(rest.lastIndexOf("@", rest.indexOf("/") < 0 ? rest.length : rest.indexOf("/")) + 1);
    rest = rest.replace(/^([^/:]+):\d+\//, "$1/");
  } else {
    const at = trimmed.lastIndexOf("@");
    rest = (at >= 0 ? trimmed.slice(at + 1) : trimmed).replace(":", "/");
  }
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[^/\s]+\/[^\s]+$/.test(rest) ? rest.toLowerCase() : null;
}

/** `*` matches any run of characters; everything else is literal and case-insensitive. */
export function patternMatches(pattern: string, key: string): boolean {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(key);
}

/** The profile a repository should use: an explicit pin wins, then the first matching rule. */
export function profileFor(
  pinned: string | null,
  rules: readonly ProfileRule[],
  remoteUrls: readonly string[],
): string | null {
  if (pinned) return pinned;
  const keys = remoteUrls.map(remoteKey).filter((k): k is string => k !== null);
  for (const rule of rules) {
    if (keys.some((k) => patternMatches(rule.pattern, k))) return rule.profileId;
  }
  return null;
}
