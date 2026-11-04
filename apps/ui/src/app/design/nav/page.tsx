import type { Metadata } from "next";
import { MiniSidebar } from "@/components/nav-variants";
import { VARIANTS } from "@/components/nav-variants-data";

export const metadata: Metadata = { title: "Sidebar link styles" };

// Side-by-side comparison of sidebar link styles. Hover and click inside each one.
export default function NavVariantsPage() {
  return (
    <div className="ah nvx-page">
      <header className="nvx-head">
        <h1>Sidebar link styles</h1>
        <p>Same org, project and links in each column; only the link style changes. Hover and click to compare. Switch theme from the account menu in the app.</p>
      </header>
      <div className="nvx-grid">
        {VARIANTS.map((v) => (
          <figure key={v.id} className="nvx-col">
            <figcaption>
              <b>{v.name}</b>
              <small>{v.spec}</small>
            </figcaption>
            <MiniSidebar variant={v.id} />
          </figure>
        ))}
      </div>
    </div>
  );
}
