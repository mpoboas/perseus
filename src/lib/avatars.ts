import { authorAvatar } from "../ipc";
import { readPref } from "./prefs";

/** Preference key; on by default. Pictures only ever come from GitHub (see `avatars.rs`). */
export const AVATAR_PREF = "avatars.enabled";

const MAX_IN_FLIGHT = 4;

/** e-mail → the picture as a `data:` URL, or null when there is none. Missing means "not asked yet". */
const urls = new Map<string, string | null>();
const images = new Map<string, HTMLImageElement>();
const queue: string[] = [];
const asked = new Set<string>();
const listeners = new Set<() => void>();
let inFlight = 0;
let notifyPending = false;

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

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const email = queue.shift()!;
    inFlight++;
    authorAvatar(email)
      .catch(() => null)
      .then((url) => {
        urls.set(email, url);
        if (url) {
          const img = new Image();
          img.onload = () => {
            images.set(email, img);
            notify();
          };
          img.src = url;
        }
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

function request(email: string) {
  if (asked.has(email) || !email.includes("@")) return;
  asked.add(email);
  queue.push(email);
  pump();
}

/** The picture as a `data:` URL when it is known; asks for it (once) when it is not. */
export function avatarUrl(email: string | undefined): string | null {
  if (!email || !avatarsEnabled()) return null;
  const k = key(email);
  request(k);
  return urls.get(k) ?? null;
}

/** The decoded picture for drawing on a canvas, or null (draw initials instead). */
export function avatarImage(email: string | undefined): HTMLImageElement | null {
  if (!email || !avatarsEnabled()) return null;
  const k = key(email);
  request(k);
  return images.get(k) ?? null;
}
