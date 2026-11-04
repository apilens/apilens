"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { joinTeam } from "@/app/(auth)/onboarding/actions";
import type { JoinableOrg } from "@/lib/identity";
import { CREATE_ORG_PATH } from "@/lib/join-org";
import { orgMark, plural } from "@/lib/scope";
import { BackNext, ObIcon, ObShell, type StepProps } from "./ob";

const stat = (n: number, l: string, border: boolean) => (
  <div style={{ padding: "12px 16px", borderLeft: border ? "1px solid var(--border)" : undefined }}>
    <b style={{ display: "block", font: "500 15px/20px var(--font-mono)" }}>{n}</b>
    <small style={{ font: "400 12px/16px var(--font-sans)", color: "var(--ink-muted)" }}>{l}</small>
  </div>
);

function Initials({ initials }: { initials: string[] }) {
  if (initials.length === 0) return null;
  return (
    <span style={{ display: "flex", flex: "none" }} aria-hidden="true">
      {initials.map((i, n) => (
        <span key={`${i}-${n}`} className="cp-av cp-av--sm" style={{ marginLeft: -6, border: "2px solid var(--surface-1)" }}>
          {i}
        </span>
      ))}
    </span>
  );
}

function Verified({ domain }: { domain: string }) {
  return (
    <small style={{ display: "flex", alignItems: "center", gap: 6, font: "400 13px/18px var(--font-sans)", color: "var(--ink-muted)" }}>
      <ObIcon name="done" />
      {domain} verified
    </small>
  );
}

/** The one organization to join: its mark, verified domain, member initials and counts. */
function OrgCard({ org, domain }: { org: JoinableOrg; domain: string }) {
  return (
    <div className="ob-card" data-testid="joinable-org">
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
        <span className="cp-orgmark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 17 }} aria-hidden="true">
          {orgMark(org)}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: "block", font: "600 16px/22px var(--font-sans)" }}>{org.name}</b>
          {domain ? <Verified domain={domain} /> : null}
        </span>
        <Initials initials={org.member_initials} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", borderTop: "1px solid var(--border)" }}>
        {stat(org.member_count, org.member_count === 1 ? "member" : "members", false)}
        {stat(org.project_count, org.project_count === 1 ? "project" : "projects", true)}
      </div>
    </div>
  );
}

/**
 * "Join your team" (#329): the organizations `orgs` (never empty: the page skips the step
 * without any) whose allowed domains hold the user's verified email `domain`. One is shown as a
 * card; several as a choice. "Join <org>" joins it and opens its first project, or the project
 * step when it has none.
 */
export function JoinOrg({ step = 1, reached = step, orgs, domain }: Partial<StepProps> & { orgs: JoinableOrg[]; domain: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState(orgs[0]?.slug ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const org = orgs.find((o) => o.slug === picked) ?? orgs[0];
  const many = orgs.length > 1;

  const join = () => {
    if (!org) return;
    setError(null);
    startTransition(async () => {
      const result = await joinTeam(org.slug, org.name);
      // Only failures come back; success navigates. Reload the list: it may have changed.
      if (!result) return;
      setError(result.error);
      if (result.code === "forbidden") router.refresh();
    });
  };

  const at = domain ? ` at ${domain}` : "";
  return (
    <ObShell
      eyebrow="02:22 AM"
      headline={["You shouldn’t have", "to wake everyone."]}
      body="Only the people who own the service hear about it, with the details attached."
      receipt={
        <>
          notified · <b>service owner</b> · trace attached
        </>
      }
      progress={26.67}
      step={step}
      reached={reached}
      badge="team"
      title="Join your team on APILens"
      lead={
        many
          ? `${orgs.length} organizations${at} already use APILens. Pick the one to join.`
          : `${org?.name ?? "Your team"} is already on APILens. You can join it now.`
      }
      footer={<BackNext back="/onboarding/about" nextLabel={org ? `Join ${org.name}` : "Join"} loading={pending} disabled={pending || !org} onNext={join} />}
    >
      {many ? (
        <div className="ob-picks" role="radiogroup" aria-label="Organization to join">
          {orgs.map((o) => (
            <button
              key={o.slug}
              type="button"
              role="radio"
              aria-checked={picked === o.slug}
              className={`ob-pick${picked === o.slug ? " on" : ""}`}
              data-testid="joinable-org"
              onClick={() => setPicked(o.slug)}
            >
              <span className="rd" />
              <span className="cp-orgmark" style={{ width: 32, height: 32, borderRadius: 9, fontSize: 14, flex: "none" }} aria-hidden="true">
                {orgMark(o)}
              </span>
              <span className="tx" style={{ flex: 1, minWidth: 0 }}>
                <b>{o.name}</b>
                <small>
                  {plural(o.member_count, "member")} · {plural(o.project_count, "project")}
                </small>
              </span>
              <Initials initials={o.member_initials} />
            </button>
          ))}
        </div>
      ) : org ? (
        <div className="ob-f">
          <OrgCard org={org} domain={domain} />
        </div>
      ) : null}
      {many && domain ? (
        <div style={{ marginTop: 12 }}>
          <Verified domain={domain} />
        </div>
      ) : null}
      {error ? (
        <div className="ob-notice ob-notice--error" role="alert">
          <ObIcon name="info" />
          <p>{error}</p>
        </div>
      ) : null}
      <div className="ob-note">
        <ObIcon name="lock" />
        <span>
          You’ll join as a <b>Member</b>. An owner or admin can change your role later.
        </span>
      </div>
      <p className="ob-p" style={{ fontSize: 13, marginTop: 22 }}>
        Not your team? <Link className="cp-link" href={CREATE_ORG_PATH}>Create a separate organization</Link>
      </p>
    </ObShell>
  );
}
