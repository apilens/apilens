"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SSO_LOOKUP_FAILED,
  SSO_NEEDS_EMAIL,
  SSO_NOT_SET_UP,
  type SSOLookupResult,
  type SSOMatch,
  lookupSSO,
  ssoLabel,
} from "@/lib/sso";
import { ObIcon } from "./ob";

/** How long typing must pause before the domain is looked up (the lookup is rate-limited per IP). */
const LOOKUP_DELAY_MS = 350;

/**
 * The SSO lookup for the sign-in and sign-up email (#323). `email` is the typed address once it
 * is valid (else null); it is looked up after a short pause and the answer kept per address.
 * `match` is the answer for the current address (null while unknown, or when there is no SSO).
 */
export function useSSOLookup(email: string | null, next?: string) {
  const cache = useRef(new Map<string, Promise<SSOLookupResult>>());
  const [found, setFound] = useState<{ email: string; match: SSOMatch | null } | null>(null);

  // A new `next` changes every start URL, so earlier answers no longer apply.
  useEffect(() => {
    cache.current.clear();
    setFound(null);
  }, [next]);

  /** The answer for `addr`, from the cache or a fresh lookup. A failed lookup is not cached. */
  const resolve = useCallback(
    (addr: string): Promise<SSOLookupResult> => {
      const key = addr.toLowerCase();
      const hit = cache.current.get(key);
      if (hit) return hit;
      const pending = lookupSSO({ email: addr, next }).then((res) => {
        if (res.kind === "error") cache.current.delete(key);
        return res;
      });
      cache.current.set(key, pending);
      return pending;
    },
    [next],
  );

  useEffect(() => {
    if (!email) return;
    let live = true;
    const timer = setTimeout(() => {
      void resolve(email).then((res) => {
        if (live) setFound({ email: email.toLowerCase(), match: res.kind === "match" ? res.match : null });
      });
    }, LOOKUP_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [email, resolve]);

  /** Records a match learnt another way (a `sso_required` refusal of the email code). */
  const remember = useCallback((addr: string, match: SSOMatch) => {
    cache.current.set(addr.toLowerCase(), Promise.resolve({ kind: "match", match }));
    setFound({ email: addr.toLowerCase(), match });
  }, []);

  /**
   * The generic "SSO" button: sends the browser to the organization's SSO for `addr`, or returns
   * the sentence to show when it cannot (no address, no SSO for the domain, lookup failed).
   */
  const go = useCallback(
    async (addr: string | null): Promise<string | null> => {
      if (!addr) return SSO_NEEDS_EMAIL;
      const res = await resolve(addr);
      if (res.kind === "match") {
        window.location.assign(res.match.startUrl);
        return null;
      }
      return res.kind === "none" ? SSO_NOT_SET_UP : SSO_LOOKUP_FAILED;
    },
    [resolve],
  );

  const match = email && found?.email === email.toLowerCase() ? found.match : null;
  return { match, resolve, remember, go };
}

/**
 * "Continue with <org> SSO": a plain link to identity's SSO start (a full-page navigation). The
 * primary action when the organization enforces SSO, otherwise a secondary button.
 */
export function SSOLink({ match, primary }: { match: SSOMatch; primary?: boolean }) {
  return (
    <a className={`ah-btn ${primary ? "ah-btn--primary" : "ah-btn--secondary"} au-btn-full`} href={match.startUrl} data-sso={match.enforced ? "enforced" : "available"}>
      <ObIcon name="lock" />
      {ssoLabel(match.orgName)}
    </a>
  );
}

/** The generic "SSO" provider button (`providers.sso`), used until the typed domain has a match. */
export function SSOButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ah-btn ah-btn--secondary${busy ? " is-loading" : ""}`} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>
      <ObIcon name="lock" />
      SSO
    </button>
  );
}
