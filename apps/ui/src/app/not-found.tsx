import Link from "next/link";

export default function NotFound() {
  return (
    <div className="ah" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", textAlign: "center", padding: "var(--space-6)" }}>
      <div>
        <p className="cp-h">404</p>
        <h1 className="cp-lede" style={{ margin: "0 auto" }}>That page doesn’t exist.</h1>
        <p className="cp-sub">It may have moved, or the project was renamed.</p>
        <p style={{ marginTop: "var(--space-6)" }}>
          <Link className="ah-btn ah-btn--primary" href="/platform/incidents">Go to platform</Link>
        </p>
      </div>
    </div>
  );
}
