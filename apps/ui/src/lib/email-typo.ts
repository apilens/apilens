// "Did you mean …@gmail.com?" under the sign-in email field: a misspelt provider domain
// (gmial.com, outlok.com) or top-level domain (.con) sends the code nowhere, and the user waits
// for an email that never comes. Client-side only, so it says nothing about which accounts exist;
// it only suggests, never blocks, since an odd-looking domain may be real.
//
// Client-safe: no server imports.

/** Domains common enough that a near miss is almost always a typo of one of them. */
const KNOWN_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "fastmail.com",
];

/** Top-level domain slips: the left side is never a real TLD people mean. */
const TLD_FIXES: Record<string, string> = {
  con: "com",
  cmo: "com",
  ocm: "com",
  vom: "com",
  xom: "com",
  comm: "com",
  coom: "com",
  cm: "com",
  om: "com",
  nte: "net",
  ent: "net",
  ogr: "org",
  rog: "org",
};

/**
 * Edit distance with adjacent transpositions (optimal string alignment: gmial → gmail is one
 * edit), capped: anything past `max` returns `max + 1`.
 */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Rows i-2 and i-1 of the table; a transposition reaches back two rows.
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The corrected address when `email`'s domain looks like a typo of a common one, else `null`.
 * Keeps the local part exactly as typed; compares the domain case-insensitively.
 */
export function suggestEmail(email: string): string | null {
  const value = email.trim();
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (KNOWN_DOMAINS.includes(domain)) return null;

  // A known name with a slipped TLD (gmail.con), or any domain with an obvious TLD slip.
  const dot = domain.lastIndexOf(".");
  if (dot > 0) {
    const fixed = TLD_FIXES[domain.slice(dot + 1)];
    if (fixed) {
      const candidate = `${domain.slice(0, dot)}.${fixed}`;
      const near = closest(candidate);
      return `${local}@${near ?? candidate}`;
    }
  }
  const near = closest(domain);
  return near ? `${local}@${near}` : null;
}

/**
 * The nearest known domain within reach of `domain`, or `null` when none is, or two are equally
 * near. Reach is one edit when either side is short (so acme.com is never "me.com"), else two.
 */
function closest(domain: string): string | null {
  if (KNOWN_DOMAINS.includes(domain)) return domain;
  let found: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const known of KNOWN_DOMAINS) {
    const reach = Math.min(domain.length, known.length) <= 7 ? 1 : 2;
    const d = distance(domain, known, reach);
    if (d > reach) continue;
    if (d < best) {
      best = d;
      found = known;
      tie = false;
    } else if (d === best) {
      tie = true;
    }
  }
  return tie ? null : found;
}
