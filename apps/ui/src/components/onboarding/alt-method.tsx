import Link from "next/link";
import type { AltMethod } from "@/lib/sign-in-methods";
import { Brand, ObIcon } from "./ob";

/**
 * A secondary sign-in button for an external provider (GitHub, Google, SSO). An absolute `href`
 * (the identity OAuth start URL) is a plain full-page navigation, never a client-side transition.
 */
export function AltLink({ method, href }: { method: Exclude<AltMethod, "email">; href: string }) {
  const content = (
    <>
      {method === "sso" ? <ObIcon name="lock" /> : <Brand src={method} />}
      {method === "github" ? "GitHub" : method === "google" ? "Google" : "SSO"}
    </>
  );
  if (/^https?:\/\//i.test(href)) {
    return (
      <a className="ah-btn ah-btn--secondary" href={href}>
        {content}
      </a>
    );
  }
  return (
    <Link className="ah-btn ah-btn--secondary" href={href}>
      {content}
    </Link>
  );
}
