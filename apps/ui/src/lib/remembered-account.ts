// The account last signed in on this device (#314), shown first on the sign-in page. It lives
// in `localStorage` as `{email, at}`: written after a successful sign-in, cleared by "Not you?".
// Storage can be blocked (private windows, disabled site data) or hold junk, so every access is
// wrapped and anything unexpected reads as "nothing remembered": the page then shows the email
// field.
//
// Client-safe: no server imports.

/** `localStorage` key holding the remembered account. */
export const REMEMBERED_ACCOUNT_KEY = "apilens.remembered-account";

export interface RememberedAccount {
  email: string;
  /** When it was last used to sign in, in ms since the epoch. */
  at: number;
}

/** The subset of `Storage` used here, so tests can pass a fake. */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // Accessing `localStorage` itself throws when site data is blocked.
  }
}

/** The remembered account, or `null` when there is none, storage is blocked or the value is bad. */
export function readRememberedAccount(store: StorageLike | null = storage()): RememberedAccount | null {
  try {
    const raw = store?.getItem(REMEMBERED_ACCOUNT_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { email, at } = v as Record<string, unknown>;
    if (typeof email !== "string" || !email.includes("@") || email.length > 320) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { email, at };
  } catch {
    return null;
  }
}

/** Remembers `email` as the account last used on this device. Silently does nothing if blocked. */
export function rememberAccount(email: string, now = Date.now(), store: StorageLike | null = storage()): void {
  const value = email.trim();
  if (!value) return;
  try {
    store?.setItem(REMEMBERED_ACCOUNT_KEY, JSON.stringify({ email: value, at: now } satisfies RememberedAccount));
  } catch {
    // Blocked or full storage: the next sign-in just starts from the email field.
  }
}

/** Forgets the remembered account ("Not you?"). */
export function forgetAccount(store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(REMEMBERED_ACCOUNT_KEY);
  } catch {
    // Nothing to do: a blocked store holds nothing to forget.
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Day-granular relative time for "Used on this device …": "today", "yesterday", "3 days ago",
 * "2 weeks ago", "5 months ago", "2 years ago". Calendar days in local time, so a sign-in at
 * 23:50 reads "yesterday" ten minutes later. A time in the future reads "today".
 */
export function relativeDay(at: number, now = Date.now()): string {
  const startOf = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(at)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (days < 14) return unit(days, "day");
  if (days < 60) return unit(Math.floor(days / 7), "week");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

/** Two-letter avatar initials from an email's local part: "amit.m@x.co" → "AM", "neel@x.co" → "NE". */
export function emailInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (letters || "?").toUpperCase();
}
