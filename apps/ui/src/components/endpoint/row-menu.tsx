"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { loadEndpointSettings, saveEndpointSettings } from "@/app/[project]/endpoints/[method]/[path]/actions";
import { QUICK_EXPECTED, isExpected, settingsBody, settingsError, thresholdText, toggleExpected, withThreshold } from "@/lib/endpoint-detail";
import type { EndpointSettings, NamedApp, PutEndpointSettingsRequest } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import "./endpoint.css";

type Scope = { project: string; apps: NamedApp[]; announce: (text: string) => void };

const RowMenuScope = createContext<Scope | null>(null);

/**
 * Wraps a table of endpoints whose rows carry an {@link EndpointRowMenu} (#600): the project and
 * its apps (settings are per app), and the one status line the menus report a save on. A save
 * reads the page again, so an endpoint excluded from metrics leaves the table, and the line says
 * where to include it again.
 */
export function EndpointRowMenus({ project, apps, children }: { project: string; apps: NamedApp[]; children: ReactNode }) {
  const [said, setSaid] = useState("");
  return (
    <RowMenuScope.Provider value={{ project, apps, announce: setSaid }}>
      {children}
      <p className="ep-rowmenu__said" role="status">
        {said}
      </p>
    </RowMenuScope.Provider>
  );
}

/**
 * The settings menu on one endpoint row (#600): mark 404 as expected, set the response time
 * threshold (in a small form in place of the menu) and exclude the endpoint from metrics, for one
 * app of the project. It reads the endpoint's settings when it opens and saves each change at once
 * through the endpoint page's Server Action. Holders of `capture.manage` change them; everyone else
 * sees them with the items disabled and the reason.
 */
export function EndpointRowMenu({ method, path }: { method: string; path: string }) {
  const scope = useContext(RowMenuScope);
  if (!scope) throw new Error("EndpointRowMenu must render inside <EndpointRowMenus>");
  const { project, apps, announce } = scope;
  const manage = useCan("capture.manage").allowed;
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "threshold">("menu");
  const [appId, setAppId] = useState(apps[0]?.id ?? "");
  const [settings, setSettings] = useState<EndpointSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [threshold, setThreshold] = useState("");
  const [thresholdErr, setThresholdErr] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();
  const ids = { menu: useId(), threshold: useId(), hint: useId(), err: useId() };
  const ep = `${method.toUpperCase()} ${path}`;
  const app = apps.find((a) => a.id === appId) ?? apps[0];

  const close = useCallback(() => {
    setOpen(false);
    setView("menu");
  }, []);

  const load = (id: string) => {
    setSettings(null);
    setFailure(null);
    startLoad(async () => {
      const result = await loadEndpointSettings(project, id, method, path);
      if (result.ok) setSettings(result.settings);
      else setFailure(result.error);
    });
  };

  const toggle = () => {
    if (open) return close();
    setView("menu");
    setOpen(true);
    load(appId);
  };

  // Keyboard users land on the first item once the settings are in, and in the field of the form.
  useEffect(() => {
    if (!open || loading) return;
    const frame = requestAnimationFrame(() => {
      const root = document.getElementById(ids.menu);
      const first = view === "threshold" ? root?.querySelector<HTMLElement>("input") : root?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
      first?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, loading, view, settings, ids.menu]);

  const save = (body: PutEndpointSettingsRequest, said: string) => {
    if (!manage || !app) return;
    setFailure(null);
    startSave(async () => {
      const result = await saveEndpointSettings(project, app.id, method, path, body);
      if (!result.ok) {
        if (view === "threshold") setThresholdErr(result.error);
        else setFailure(result.error);
        return;
      }
      setSettings(result.settings);
      close();
      trigger.current?.focus();
      announce(said);
      router.refresh();
    });
  };

  const onThreshold = (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    const next = withThreshold(settings, threshold);
    if (!next.ok) {
      setThresholdErr(next.error);
      return;
    }
    setThresholdErr(null);
    const ms = next.settings.latency_threshold_ms;
    save(next.settings, ms === null ? `${ep} uses the app’s response time threshold again.` : `${ep} counts requests slower than ${thresholdText(ms)} as slow.`);
  };

  const inApp = apps.length > 1 && app ? ` in app ${app.name}` : "";
  const expected = settings ? isExpected(settings, QUICK_EXPECTED) : false;
  const disabled = !manage || !settings || saving;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ep-rowmenu${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Settings for ${ep}`}
        title="Endpoint settings"
        onClick={toggle}
      >
        <Icon name="settings" />
      </button>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label={view === "threshold" ? `Response time threshold for ${ep}` : `Settings for ${ep}`} align="end" role={view === "threshold" ? "dialog" : "menu"} id={ids.menu}>
        {view === "threshold" && settings ? (
          <form className="ep-rowmenu__form" onSubmit={onThreshold} noValidate>
            <label htmlFor={ids.threshold}>Response time threshold (ms)</label>
            <input
              id={ids.threshold}
              className="ep-input"
              inputMode="numeric"
              autoComplete="off"
              placeholder="App default"
              value={threshold}
              disabled={saving}
              aria-invalid={thresholdErr ? true : undefined}
              aria-describedby={`${ids.hint}${thresholdErr ? ` ${ids.err}` : ""}`}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <p id={ids.hint} className="ep-hint">
              Requests slower than this are slow{inApp}. Empty uses the app’s.
            </p>
            {thresholdErr ? (
              <p id={ids.err} className="ep-err" role="alert">
                {thresholdErr}
              </p>
            ) : null}
            <div className="ep-rowmenu__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setView("menu")}>
                Back
              </button>
              <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${saving ? " is-loading" : ""}`} aria-disabled={saving || undefined}>
                Save threshold
              </button>
            </div>
          </form>
        ) : (
          <>
            {apps.length > 1 ? (
              <>
                <p className="menu-label">App</p>
                {apps.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={a.id === appId}
                    className="cp-sitem"
                    disabled={saving}
                    onClick={() => {
                      if (a.id === appId) return;
                      setAppId(a.id);
                      load(a.id);
                    }}
                  >
                    <span className="lb">{a.name}</span>
                    {a.id === appId ? (
                      <span className="sl">
                        <Icon name="check" />
                      </span>
                    ) : null}
                  </button>
                ))}
                <hr />
              </>
            ) : null}
            {manage ? null : <p className="ep-rowmenu__note">{settingsError("forbidden")}</p>}
            {loading ? (
              <p className="ep-rowmenu__note" role="status">
                Loading settings…
              </p>
            ) : null}
            {failure ? (
              <p className="ep-err ep-rowmenu__note" role="alert">
                {failure}
              </p>
            ) : null}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={expected}
              className="cp-sitem"
              disabled={disabled}
              onClick={() =>
                settings &&
                save(
                  toggleExpected(settings, QUICK_EXPECTED),
                  expected ? `${ep} counts 404 responses as client errors again.` : `${ep} no longer counts 404 responses as client errors.`,
                )
              }
            >
              <span className="lb">Mark {QUICK_EXPECTED} as expected</span>
              {expected ? (
                <span className="sl">
                  <Icon name="check" />
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              className="cp-sitem"
              disabled={disabled}
              onClick={() => {
                if (!settings) return;
                setThreshold(settings.latency_threshold_ms === null ? "" : String(settings.latency_threshold_ms));
                setThresholdErr(null);
                setView("threshold");
              }}
            >
              <span className="lb">Response time threshold</span>
              <span className="ep-rowmenu__value">{settings ? thresholdText(settings.latency_threshold_ms) : null}</span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={settings?.excluded ?? false}
              className="cp-sitem"
              disabled={disabled}
              onClick={() =>
                settings &&
                save(
                  { ...settingsBody(settings), excluded: !settings.excluded },
                  settings.excluded ? `${ep} counts in metrics again.` : `${ep} is excluded from metrics. Its requests stay in Explore; include it again from its endpoint page.`,
                )
              }
            >
              <span className="lb">Exclude from metrics</span>
              {settings?.excluded ? (
                <span className="sl">
                  <Icon name="check" />
                </span>
              ) : null}
            </button>
          </>
        )}
      </PopMenu>
    </>
  );
}
