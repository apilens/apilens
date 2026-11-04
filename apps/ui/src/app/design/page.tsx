import type { Metadata } from "next";
import Link from "next/link";
import tokens from "../../../design/tokens.json";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Design system" };

type Tok = { name: string; value: string | Record<string, string>; usage: string };
const v = (t: Tok, theme: string) => (typeof t.value === "string" ? t.value : (t.value[theme] ?? Object.values(t.value)[0]));

export default function Design() {
  return (
    <div className="ah" style={{ padding: "var(--space-12) var(--space-8)", maxWidth: 1120, margin: "0 auto" }}>
      <header className="pagehead" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Logo height={44} />
          <h1 className="cp-lede" style={{ marginTop: "var(--space-6)" }}>Design system</h1>
          <p className="cp-sub">Tokens and components, rendered from design/tokens.json and bundle.css. <Link className="cp-link" href="/platform/incidents">Open the app</Link></p>
        </div>
      </header>

      <section className="cp-sec"><h2 className="cp-h">Button</h2>
        <div className="demo">
          <a className="ah-btn ah-btn--primary" href="#">Continue <span className="ah-kbd">↵</span></a>
          <a className="ah-btn ah-btn--secondary" href="#">Copy command</a>
          <a className="ah-btn ah-btn--ghost" href="#">Skip for now</a>
          <a className="ah-btn ah-btn--primary is-loading" href="#">Continue</a>
          <a className="ah-btn ah-btn--primary is-disabled" href="#">Disabled</a>
          <a className="ah-btn ah-btn--primary ah-btn--sm" href="#">Small · 32</a>
          <a className="ah-btn ah-btn--primary" href="#">Medium · 40</a>
          <a className="ah-btn ah-btn--primary ah-btn--lg" href="#">Large · 44</a>
        </div>
      </section>

      <section className="cp-sec"><h2 className="cp-h">Status</h2>
        <div className="demo">
          <span className="ah-badge ah-badge--ok">200 OK</span>
          <span className="ah-badge ah-badge--warn">Slow</span>
          <span className="ah-badge ah-badge--error">503</span>
          <span className="ah-chip"><span className="ah-dot" /><b>All systems operational</b></span>
          {(["ok", "warn", "error", "info", "none"] as const).map((s) => <span key={s} style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><span className={`ah-sev ah-sev--${s}`} />{s}</span>)}
          <span className="ah-kbd">⌘K</span>
        </div>
      </section>

      <section className="cp-sec"><h2 className="cp-h">Color · dark and light</h2>
        <div className="sw-grid">
          {(tokens.color.tokens as Tok[]).map((t) => (
            <div key={t.name} className="sw">
              <i style={{ background: `var(--${t.name})` }} />
              <div><b>{t.name}</b>{v(t, "dark")} · {v(t, "light")}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="cp-sec"><h2 className="cp-h">Type</h2>
        <div className="stack">
          {tokens.type.groups.flatMap((g) => g.styles.map((s) => ({ ...s, family: g.family }))).map((s) => (
            <div key={s.name} className="list-row" style={{ gridTemplateColumns: "120px minmax(0,1fr) auto", minHeight: 56, border: 0, borderBottom: "1px solid var(--border)" }}>
              <span className="muted mono">{s.name}</span>
              <span style={{ fontFamily: `var(--font-${s.family})`, fontSize: Math.min(parseInt(s.fontSize), 40), lineHeight: s.lineHeight, fontWeight: s.fontWeight, letterSpacing: "letterSpacing" in s ? s.letterSpacing : undefined, textTransform: s.name === "eyebrow" ? "uppercase" : undefined }}>
                {"sample" in s ? s.sample : "Is anything wrong?"}
              </span>
              <span className="muted mono">{s.fontSize}/{s.lineHeight}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="cp-sec"><h2 className="cp-h">Spacing</h2>
        <div className="stack">
          {tokens.spacing.tokens.map((s) => (
            <div key={s.name} className="list-row" style={{ gridTemplateColumns: "100px 60px minmax(0,1fr)", border: 0, minHeight: 32 }}>
              <span className="mono">{s.name}</span><span className="mono muted">{s.value}</span>
              <span style={{ display: "block", height: 8, width: s.value, background: "var(--accent)", borderRadius: 2 }} />
            </div>
          ))}
        </div>
      </section>

      <section className="cp-sec"><h2 className="cp-h">Radius</h2>
        <div className="demo">
          {tokens.radius.tokens.map((r) => (
            <div key={r.name} style={{ width: 96, height: 64, border: "1px solid var(--border-strong)", background: "var(--surface-2)", borderRadius: r.value, display: "grid", placeItems: "center", font: "400 12px/1 var(--font-mono)" }}>{r.name.replace("radius-", "")} {r.value}</div>
          ))}
        </div>
      </section>
    </div>
  );
}
