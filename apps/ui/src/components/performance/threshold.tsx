"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { saveAppThreshold } from "@/app/[project]/performance/actions";
import type { AppSettings, NamedApp } from "@/lib/identity";
import { DEFAULT_THRESHOLD_MS, checkThresholdDraft, thresholdDraft } from "@/lib/performance";
import { useCan } from "@/lib/permissions";

/**
 * The app settings of the Performance page (#595): a button opening a dialog with the response
 * time threshold of the app in scope, the Apdex threshold of its endpoints that set none of their
 * own. Holders of `capture.manage` edit and save; everyone else sees the value read-only. A saved
 * threshold applies to the reads at once, so the page reads itself again and the Apdex is recomputed.
 */
export function AppThresholdMenu({ project, app, settings }: { project: string; app: NamedApp; settings: AppSettings }) {
  const manage = useCan("capture.manage").allowed;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => thresholdDraft(settings));
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDialogElement>(null);
  const ids = { title: useId(), threshold: useId(), hint: useId(), err: useId() };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const openDialog = () => {
    setDraft(thresholdDraft(settings));
    setError(null);
    setFailure(null);
    setSaved(null);
    setOpen(true);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage) return;
    const checked = checkThresholdDraft(draft);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setFailure(null);
    startTransition(async () => {
      const result = await saveAppThreshold(project, app.id, checked.threshold);
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      setOpen(false);
      setSaved(`Threshold saved: ${result.settings.apdex_threshold_ms} ms for ${app.name}. Apdex now scores against it.`);
      router.refresh();
    });
  };

  return (
    <div className="ep-settings pf-settings">
      <p className="ep-saved" role="status">
        {saved}
      </p>
      <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" aria-haspopup="dialog" onClick={openDialog}>
        App settings
      </button>
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
            <h2 id={ids.title}>App settings</h2>
            <p className="ep-dialog__lead">For app {app.name}, every environment</p>
            {manage ? null : <p className="ep-note">You can see this setting. Only project admins can change it.</p>}
            <fieldset disabled={!manage || pending} className="ep-fields">
              <div className="ep-field">
                <label htmlFor={ids.threshold}>Response time threshold (ms)</label>
                <input
                  id={ids.threshold}
                  className="ep-input ep-input--short"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={`${DEFAULT_THRESHOLD_MS} (default)`}
                  value={draft}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`${ids.hint}${error ? ` ${ids.err}` : ""}`}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <p id={ids.hint} className="ep-hint">
                  The Apdex target of this app’s endpoints: requests within it are satisfied, within four times it tolerating. An endpoint’s own threshold
                  wins. Empty uses {DEFAULT_THRESHOLD_MS} ms.
                </p>
                {error ? (
                  <p id={ids.err} className="ep-err">
                    {error}
                  </p>
                ) : null}
              </div>
            </fieldset>
            {failure ? (
              <p className="ep-err" role="alert">
                {failure}
              </p>
            ) : null}
            <div className="ep-dialog__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setOpen(false)}>
                {manage ? "Cancel" : "Close"}
              </button>
              {manage ? (
                <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} aria-disabled={pending || undefined}>
                  Save threshold
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  );
}
