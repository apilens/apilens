// Organization settings → Deleted projects (#822): the copy and date helpers of the card that
// restores a deleted project before its purge (#753 D8). Client-safe: no server imports.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string {
  if (ms < HOUR) {
    const m = Math.max(1, Math.floor(ms / MINUTE));
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(ms / DAY);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** `just now`, `5 minutes ago`, `2 days ago`; empty for a value that is not a date. */
export function agoText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ago = now - t;
  return ago < MINUTE ? "just now" : `${span(ago)} ago`;
}

/** `in 5 days`, `in 3 hours`, `in a minute or less` (the purge is due); empty for a value that is not a date. */
export function inText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ahead = t - now;
  return ahead < MINUTE ? "in a minute or less" : `in ${span(ahead)}`;
}

/** The sentence a failed restore shows next to the project; `reauth_required` opens the dialog instead. */
export function restoreError(code: string | undefined): string {
  switch (code) {
    case "not_found":
      return "This project can’t be restored any more: it was restored already or its data has been removed. Reload the page to see the current list.";
    case "forbidden":
      return "Only organization owners and admins can restore projects.";
    case "authz_unavailable":
    case "unavailable":
      return "Permissions couldn’t be checked just now. Try again in a moment.";
    default:
      return "Couldn’t restore the project. Try again in a moment.";
  }
}
