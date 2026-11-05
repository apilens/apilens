"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { saveEndpointSettings } from "@/app/[project]/endpoints/[method]/[path]/actions";
import { type EndpointRef, type SettingsDraft, type SettingsErrors, checkSettingsDraft, settingsDraft } from "@/lib/endpoint-detail";
import type { EndpointSettings, NamedApp } from "@/lib/identity";
import { useCan } from "@/lib/permissions";

/**
 * The endpoint's settings menu (#593): a button opening a dialog with the endpoint's expected
 * status codes, latency threshold and exclusion for the app in scope. Holders of `capture.manage`
 * edit and save; everyone else sees the values read-only. Saved settings apply to the dashboard
 * reads at once, so the page reads itself again after a save.
 */
export function SettingsMenu({ project, endpoint, app, settings }: { project: string; endpoint: EndpointRef; app: NamedApp; settings: EndpointSettings }) {
  const manage = useCan("capture.manage").allowed;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(settings));
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDialogElement>(null);
  const ids = { title: useId(), codes: useId(), codesHint: useId(), codesErr: useId(), threshold: useId(), thresholdHint: useId(), thresholdErr: useId(), excluded: useId(), excludedHint: useId(), failure: useId() };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const openDialog = () => {
    setDraft(settingsDraft(settings));
    setErrors({});
    setFailure(null);
    setSaved(null);
    setOpen(true);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage) return;
    const checked = checkSettingsDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    startTransition(async () => {
      const result = await saveEndpointSettings(project, app.id, endpoint.method, endpoint.path, checked.settings);
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      setOpen(false);
      setSaved("Settings saved. The tabs now count with them.");
      router.refresh();
    });
  };

  return (
    <div className="ep-settings">
      <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" aria-haspopup="dialog" onClick={openDialog}>
        Endpoint settings
      </button>
      <p className="ep-saved" role="status">
        {saved}
      </p>
      <dialog
        ref={ref}
        className="ep-dialog"
        aria-labelledby={ids.title}
        onClose={() => setOpen(false)}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        {open ? (
          <form className="ep-dialog__in" onSubmit={onSubmit} noValidate>
            <h2 id={ids.title}>Endpoint settings</h2>
            <p className="ep-dialog__lead">
              <b>{endpoint.method}</b> <code>{endpoint.path}</code> in app {app.name}
            </p>
            {manage ? null : <p className="ep-note">You can see these settings. Only project admins can change them.</p>}
            <fieldset disabled={!manage || pending} className="ep-fields">
              <div className="ep-field">
                <label htmlFor={ids.codes}>Expected status codes</label>
                <input
                  id={ids.codes}
                  className="ep-input"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="404, 409"
                  value={draft.codes}
                  aria-invalid={errors.codes ? true : undefined}
                  aria-describedby={`${ids.codesHint}${errors.codes ? ` ${ids.codesErr}` : ""}`}
                  onChange={(e) => setDraft({ ...draft, codes: e.target.value })}
                />
                <p id={ids.codesHint} className="ep-hint">
                  Responses with these codes are not counted as client or server errors.
                </p>
                {errors.codes ? (
                  <p id={ids.codesErr} className="ep-err">
                    {errors.codes}
                  </p>
                ) : null}
              </div>
              <div className="ep-field">
                <label htmlFor={ids.threshold}>Response time threshold (ms)</label>
                <input
                  id={ids.threshold}
                  className="ep-input ep-input--short"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="App default"
                  value={draft.threshold}
                  aria-invalid={errors.threshold ? true : undefined}
                  aria-describedby={`${ids.thresholdHint}${errors.threshold ? ` ${ids.thresholdErr}` : ""}`}
                  onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
                />
                <p id={ids.thresholdHint} className="ep-hint">
                  Requests slower than this are slow, and it is the endpoint’s Apdex target. Empty uses the app’s (500 ms unless set).
                </p>
                {errors.threshold ? (
                  <p id={ids.thresholdErr} className="ep-err">
                    {errors.threshold}
                  </p>
                ) : null}
              </div>
              <div className="ep-field ep-field--check">
                <input id={ids.excluded} type="checkbox" checked={draft.excluded} aria-describedby={ids.excludedHint} onChange={(e) => setDraft({ ...draft, excluded: e.target.checked })} />
                <label htmlFor={ids.excluded}>Exclude from dashboards</label>
                <p id={ids.excludedHint} className="ep-hint">
                  Leaves the endpoint out of traffic totals, the endpoints list and errors. Its requests stay in the request log.
                </p>
              </div>
            </fieldset>
            {failure ? (
              <p id={ids.failure} className="ep-err" role="alert">
                {failure}
              </p>
            ) : null}
            <div className="ep-dialog__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setOpen(false)}>
                {manage ? "Cancel" : "Close"}
              </button>
              {manage ? (
                <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} aria-disabled={pending || undefined}>
                  Save settings
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  );
}
