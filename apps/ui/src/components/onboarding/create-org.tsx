"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BackNext, ObIcon, ObShell } from "./ob";

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const TAKEN = ["apilens", "acme", "northwind", "admin"];

export function CreateOrg() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const address = edited ? slug : slugify(name);
  const taken = TAKEN.includes(address);
  const ok = name.trim().length > 1 && address.length > 1 && !taken;

  return (
    <ObShell
      eyebrow="02:24 AM"
      headline={["It’s not about who.", "It’s about what."]}
      body="Clear evidence makes it easier to stay kind at 2 a.m."
      receipt={
        <>
          cause · <b>v2.8.1</b> · one config change
        </>
      }
      progress={33.33}
      step={1}
      badge="building"
      title="Name your organization"
      lead="Usually your company. It holds projects, people and billing."
      footer={<BackNext back="/onboarding/join" nextLabel="Create organization" disabled={!ok} onNext={() => router.push("/platform/incidents")} />}
    >
      <div className="ob-f">
        <label className="ob-l" htmlFor="org-name">
          Name
        </label>
        <div className="ob-in">
          <ObIcon name="building" />
          <input id="org-name" autoFocus autoComplete="organization" placeholder="Motadata" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="ob-f">
        <label className="ob-l" htmlFor="org-slug">
          Address<small>used in links and the CLI</small>
        </label>
        <div className={`ob-in${taken ? " bad" : ""}`}>
          <ObIcon name="link" />
          <span className="pre">app.apilens.dev/</span>
          <input id="org-slug" value={address} onChange={(e) => { setEdited(true); setSlug(slugify(e.target.value)); }} aria-invalid={taken} aria-describedby={taken ? "slug-err" : undefined} />
          {address && !taken ? (
            <span className="r">
              <ObIcon name="done" />
              Available
            </span>
          ) : null}
        </div>
        {taken ? (
          <p id="slug-err" className="ob-err">
            That address is taken. Try adding your region or team.
          </p>
        ) : null}
      </div>
      <div className="ob-note">
        <ObIcon name="team" />
        <span>Anyone you invite later joins this organization. You can rename it anytime.</span>
      </div>
    </ObShell>
  );
}
