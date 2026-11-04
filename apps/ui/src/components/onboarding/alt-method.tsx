import Link from "next/link";
import type { AltMethod } from "@/lib/sign-in-methods";
import { Brand, ObIcon } from "./ob";

/** A secondary sign-in button for an external provider (GitHub, Google, SSO). */
export function AltLink({ method, href }: { method: Exclude<AltMethod, "email">; href: string }) {
  return (
    <Link className="ah-btn ah-btn--secondary" href={href}>
      {method === "sso" ? <ObIcon name="lock" /> : <Brand src={method} label={method} />}
      {method === "github" ? "GitHub" : method === "google" ? "Google" : "SSO"}
    </Link>
  );
}
