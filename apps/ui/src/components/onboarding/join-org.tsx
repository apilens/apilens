import Link from "next/link";
import { BackNext, ObIcon, ObShell } from "./ob";

const stat = (n: string, l: string, border: boolean) => (
  <div style={{ padding: "12px 16px", borderLeft: border ? "1px solid var(--border)" : undefined }}>
    <b style={{ display: "block", font: "500 15px/20px var(--font-mono)" }}>{n}</b>
    <small style={{ font: "400 12px/16px var(--font-sans)", color: "var(--ink-muted)" }}>{l}</small>
  </div>
);

/** Branch: the email domain already has an organization. */
export function JoinOrg() {
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
      step={1}
      badge="team"
      title="Join your team on APILens"
      lead="Motadata already has an organization. You can join it now."
      footer={<BackNext back="/onboarding/about" next="/platform/incidents" nextLabel="Join Motadata" />}
    >
      <div className="ob-f">
        <div className="ob-card">
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
            <span className="cp-orgmark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 17 }}>M</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ display: "block", font: "600 16px/22px var(--font-sans)" }}>Motadata</b>
              <small style={{ display: "flex", alignItems: "center", gap: 6, font: "400 13px/18px var(--font-sans)", color: "var(--ink-muted)" }}>
                <ObIcon name="done" />
                motadata.com verified
              </small>
            </span>
            <span style={{ display: "flex" }}>
              {["RK", "PS", "NJ"].map((i) => (
                <span key={i} className="cp-av cp-av--sm" style={{ marginLeft: -6, border: "2px solid var(--surface-1)" }}>
                  {i}
                </span>
              ))}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", borderTop: "1px solid var(--border)" }}>
            {stat("3", "members", false)}
            {stat("3", "projects", true)}
            {stat("12", "services", true)}
          </div>
        </div>
      </div>
      <div className="ob-note">
        <ObIcon name="lock" />
        <span>
          You’ll join as a <b>Viewer</b>. Ravi Kumar (Owner) gets a request to make you an Editor.
        </span>
      </div>
      <p className="ob-p" style={{ fontSize: 13, marginTop: 22 }}>
        Not your team? <Link className="cp-link" href="/onboarding/create">Create a separate organization</Link>
      </p>
    </ObShell>
  );
}
