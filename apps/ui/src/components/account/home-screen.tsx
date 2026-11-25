"use client";

import { type FormEvent, useId, useState, useTransition } from "react";
import { type SaveHomeScreenResult, saveHomeScreen } from "@/app/settings/home-actions";
import type { HomeScreen } from "@/lib/identity";
import { HOME_SCREEN_CHOICES } from "@/lib/landing";
import "../org-settings/org-settings.css";
import "./account.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/** `/settings/preferences` (#994): the account's preferences, one card each. */
export function PreferencesSettings({ home }: { home: HomeScreen | null }) {
  return (
    <div className="os acct-os">
      <HomeScreenCard initial={home} />
    </div>
  );
}

/**
 * The "Home screen" card (#994): the view a project opens on, the same choice onboarding asks
 * for. `initial` is the saved one, null when none is saved yet.
 */
function HomeScreenCard({ initial }: { initial: HomeScreen | null }) {
  const id = useId();
  const [saved, setSaved] = useState<HomeScreen | null>(initial);
  // A stored screen whose page is not live any more (Exceptions, while Errors
  // is "Coming soon") shows the choice it now opens, so a radio is always on.
  const [selected, setSelected] = useState<HomeScreen | null>(
    initial && HOME_SCREEN_CHOICES.some((c) => c.id === initial) ? initial : initial ? HOME_SCREEN_CHOICES[0].id : null,
  );
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const dirty = selected !== null && selected !== saved;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !selected || pending) return;
    start(async () => {
      const result: SaveHomeScreenResult = await saveHomeScreen(selected);
      if (result.ok) {
        setSaved(result.home);
        setSelected(result.home);
        setStatus({ tone: "ok", text: "Home screen saved." });
      } else {
        setStatus({ tone: "err", text: result.error });
      }
    });
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby={`${id}-head`}>
      <div className="os-card__head">
        <h2 id={`${id}-head`}>Home screen</h2>
        <p>What a project opens on when you sign in. A project without data opens SDK setup instead.</p>
      </div>
      <div className="os-card__body">
        <fieldset className="ac-home" disabled={pending}>
          <legend className="sr-only">Home screen</legend>
          {HOME_SCREEN_CHOICES.map((c) => (
            <label key={c.id} className={`ac-home__choice${selected === c.id ? " on" : ""}`}>
              <input
                type="radio"
                name={`${id}-home`}
                value={c.id}
                checked={selected === c.id}
                aria-describedby={`${id}-${c.id}-help`}
                onChange={() => {
                  setSelected(c.id);
                  setStatus(null);
                }}
              />
              <span>
                <b>{c.label}</b>
                <span id={`${id}-${c.id}-help`}>{c.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="os-card__foot">
        <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
        {dirty ? (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setSelected(saved)} disabled={pending}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || pending}>
          Save
        </button>
      </div>
    </form>
  );
}
