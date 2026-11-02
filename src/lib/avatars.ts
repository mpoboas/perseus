import { authorAvatar, remoteAvatar } from "../ipc";
import { readPref } from "./prefs";

/** Preference keys. Pictures are on by default; Gravatar (a third party) is opt-in. */
export const AVATAR_PREF = "avatars.enabled";
export const GRAVATAR_PREF = "avatars.gravatar";

const MAX_IN_FLIGHT = 4;

/** e-mail → the picture as a `data:` URL, or null when there is none. Missing means "not asked yet". */
const urls = new Map<string, string | null>();
const images = new Map<string, HTMLImageElement>();
const queue: { email: string; sha: string }[] = [];
const asked = new Set<string>();
const listeners = new Set<() => void>();
let inFlight = 0;
let notifyPending = false;
let repoId: number | null = null;
let owner: HTMLImageElement | null = null;

const key = (email: string) => email.trim().toLowerCase();

export const avatarsEnabled = () => readPref<boolean>(AVATAR_PREF, true);

function notify() {
  if (notifyPending) return;
  notifyPending = true;
  queueMicrotask(() => {
    notifyPending = false;
    listeners.forEach((f) => f());
  });
}

/** Calls `fn` whenever a picture arrives; returns the unsubscribe function. */
export function subscribeAvatars(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load(url: string, done: (img: HTMLImageElement) => void) {
  const img = new Image();
  img.onload = () => done(img);
  img.src = url;
}

function pump() {
  while (repoId !== null && inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const { email, sha } = queue.shift()!;
    const forRepo = repoId;
    inFlight++;
    authorAvatar(forRepo, email, sha, readPref<boolean>(GRAVATAR_PREF, false))
      .catch(() => null)
      .then((url) => {
        if (forRepo !== repoId) return; // the user moved to another repository meanwhile
        urls.set(email, url);
        if (url) {
          load(url, (img) => {
            images.set(email, img);
            notify();
          });
        }
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

/** Tells the cache which repository to ask about (a commit there names the GitHub account). */
export function setAvatarRepo(id: number | null) {
  if (id === repoId) return;
  repoId = id;
  queue.length = 0;
  // Pictures found stay; people without one are asked about again, since another repository may know them.
  asked.clear();
  for (const [email, url] of urls) if (!url) urls.delete(email);
  owner = null;
  if (id !== null && avatarsEnabled()) {
    remoteAvatar(id)
      .catch(() => null)
      .then((url) => {
        if (url && id === repoId) {
          load(url, (img) => {
            owner = img;
            notify();
          });
        }
      });
  }
  notify();
}

function request(email: string, sha: string) {
  if (asked.has(email) || urls.get(email) || !email.includes("@") || sha.length !== 40) return;
  asked.add(email);
  queue.push({ email, sha });
  pump();
}

/** The picture as a `data:` URL when it is known; asks for it (once) when it is not. */
export function avatarUrl(email: string | undefined, sha?: string): string | null {
  if (!email || !avatarsEnabled()) return null;
  const k = key(email);
  if (sha) request(k, sha);
  return urls.get(k) ?? null;
}

/** The decoded picture for drawing on a canvas, or null (draw initials instead). */
export function avatarImage(email: string | undefined, sha?: string): HTMLImageElement | null {
  if (!email || !avatarsEnabled()) return null;
  const k = key(email);
  if (sha) request(k, sha);
  return images.get(k) ?? null;
}

/** The remote account's picture, drawn on branch labels instead of a cloud when it is known. */
export const ownerImage = () => (avatarsEnabled() ? owner : null);
