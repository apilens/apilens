"use client";

import { useId, useState } from "react";
import { CREATE_APPS_HELP, type KeyAccess, LIMITED_NO_CREATE } from "@/lib/api-keys";
import type { ManagedApp } from "@/lib/identity";

/**
 * The app access of an ingest key, for the create and edit dialogs: whether its data with a new
 * app name creates the app ("Can create apps", on by default), and whether it may send data for
 * every app or only the ones picked. Picking apps turns "Can create apps" off and says why (a key
 * limited to apps never creates apps); going back to all apps restores the earlier choice, and the
 * picked apps survive the switch. `pickable` is null when the project's apps could not be read.
 */
export function AccessFields({ value, onChange, pickable, disabled }: { value: KeyAccess; onChange: (next: KeyAccess) => void; pickable: ManagedApp[] | null; disabled?: boolean }) {
  const id = useId();
  const [picked, setPicked] = useState<string[]>(value.appIds ?? []);
  const [create, setCreate] = useState(value.appIds === null ? value.canCreateApps : true);
  const limited = value.appIds !== null;
  const cannotLimit = pickable === null || pickable.length === 0;
  const limitNote =
    pickable === null
      ? "Couldn’t load this project’s apps, so the key can’t be limited right now. Reload the page to try again."
      : pickable.length === 0
        ? "This project has no apps yet. They appear when an SDK sends its first data; you can limit the key after that."
        : null;

  const pick = (appId: string, on: boolean) => {
    const current = value.appIds ?? [];
    const next = on ? [...current.filter((x) => x !== appId), appId] : current.filter((x) => x !== appId);
    setPicked(next);
    onChange({ canCreateApps: false, appIds: next });
  };

  return (
    <>
      <div className="ob-f">
        <label className={`ak-scope${value.canCreateApps && !limited ? " on" : ""}${limited ? " is-off" : ""}`}>
          <input
            type="checkbox"
            checked={value.canCreateApps && !limited}
            disabled={disabled || limited}
            aria-describedby={`${id}-create-help`}
            onChange={(e) => {
              setCreate(e.currentTarget.checked);
              onChange({ canCreateApps: e.currentTarget.checked, appIds: null });
            }}
          />
          <span>
            <b>Can create apps</b>
            <span id={`${id}-create-help`}>{limited ? LIMITED_NO_CREATE : CREATE_APPS_HELP}</span>
          </span>
        </label>
      </div>

      <fieldset className="ob-f ak-scopes" disabled={disabled}>
        <legend className="ob-l">Apps it may send data for</legend>
        <label className={`ak-scope${!limited ? " on" : ""}`}>
          <input type="radio" name={`${id}-limit`} checked={!limited} onChange={() => onChange({ canCreateApps: create, appIds: null })} />
          <span>
            <b>All apps</b>
            <span>Data for any app of the project is accepted.</span>
          </span>
        </label>
        <label className={`ak-scope${limited ? " on" : ""}${cannotLimit ? " is-off" : ""}`}>
          <input
            type="radio"
            name={`${id}-limit`}
            checked={limited}
            disabled={cannotLimit}
            aria-describedby={limitNote ? `${id}-limit-note` : undefined}
            onChange={() => onChange({ canCreateApps: false, appIds: picked })}
          />
          <span>
            <b>Limit to apps</b>
            <span>Only the apps you pick. Data with any other app name is rejected.</span>
          </span>
        </label>
        {limitNote ? (
          <p id={`${id}-limit-note`} className="ak-hint">
            {limitNote}
          </p>
        ) : null}
        {limited && pickable && pickable.length > 0 ? (
          <ul className="ak-picks" aria-label="Apps this key may send data for">
            {pickable.map((a) => (
              <li key={a.id}>
                <label>
                  <input type="checkbox" checked={(value.appIds ?? []).includes(a.id)} onChange={(e) => pick(a.id, e.currentTarget.checked)} />
                  <span>{a.name}</span>
                  {a.slug !== a.name ? <code>{a.slug}</code> : null}
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
    </>
  );
}
