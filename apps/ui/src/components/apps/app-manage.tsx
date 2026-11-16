"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent, createContext, useCallback, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { type AppActionResult, acknowledgeApp, archiveApp, deleteApp, mergeApp, renameApp, restoreApp } from "@/app/[project]/apps/actions";
import { MAX_APP_NAME, STATE_LABEL, canDelete, canRestore, checkAppName, doneText, mergeExplainer, mergeTargets, originText, stateText } from "@/lib/app-manage";
import type { ManagedApp } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import { PopMenu } from "../pop-menu";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "../project-settings/api-keys.css";

type Said = { tone: "ok" | "err"; text: string } | null;

interface Manage {
  project: string;
  /** Every app of the project, every state. */
  apps: readonly ManagedApp[];
  /** Whether the reader holds `capture.manage`. */
  canManage: boolean;
  announce: (said: Said) => void;
  rename: (app: ManagedApp) => void;
  merge: (app: ManagedApp) => void;
}

const ManageScope = createContext<Manage | null>(null);

function useManage(): Manage {
  const m = useContext(ManageScope);
  if (!m) throw new Error("App management controls must render inside <AppManager>");
  return m;
}

/** What managing an app is called when the reader may not, shown once on the page. */
export const APPS_READ_ONLY = "You can see this project’s apps but not change them. Project admins can rename, merge, archive and restore apps.";

/**
 * Wraps the Apps page: the project's apps (from `GET /projects/{slug}/apps`), whether the reader
 * may manage them, the one status line every action reports on and the rename and merge dialogs
 * (one of each for the page). Each write runs a Server Action that revalidates the page, so the
 * cards, notices and the Archived section show the new state.
 */
export function AppManager({ project, apps, children }: { project: string; apps: readonly ManagedApp[]; children: ReactNode }) {
  const canManage = useCan("capture.manage").allowed;
  const [said, setSaid] = useState<Said>(null);
  const [renaming, setRenaming] = useState<ManagedApp | null>(null);
  const [merging, setMerging] = useState<ManagedApp | null>(null);
  return (
    <ManageScope.Provider value={{ project, apps, canManage, announce: setSaid, rename: setRenaming, merge: setMerging }}>
      <p className={`ap-said${said ? ` ap-said--${said.tone}` : ""}`} role="status" aria-live="polite">
        {said?.text ?? ""}
      </p>
      {children}
      {renaming ? <RenameDialog app={renaming} onClose={() => setRenaming(null)} /> : null}
      {merging ? <MergeDialog app={merging} onClose={() => setMerging(null)} /> : null}
    </ManageScope.Provider>
  );
}

/** Runs one write and reports it: the success sentence, or the action's error. */
function useWrite() {
  const { announce } = useManage();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (write: () => Promise<AppActionResult>, done: string, after?: () => void) => {
    announce(null);
    start(async () => {
      const result = await write();
      if (!result.ok) {
        announce({ tone: "err", text: result.error });
        return;
      }
      announce({ tone: "ok", text: done });
      after?.();
      router.refresh();
    });
  };
  return { pending, run };
}

function Dots() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

/** Puts focus on a menu's first item as it mounts, so the keyboard lands in the menu. */
function focusFirst(el: HTMLDivElement | null) {
  el?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
}

/** Arrow keys, Home and End move between a menu's items. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number | null = null;
  if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next === null) return;
  e.preventDefault();
  items[next].focus();
}

/**
 * The actions menu on an active app's card: Rename, Merge into… and Archive (not for the default
 * app, which receives data that names no app). Rendered only for readers who may manage apps.
 */
export function AppActionsMenu({ app }: { app: ManagedApp }) {
  const { project, apps, canManage, rename, merge } = useManage();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { pending, run } = useWrite();
  const close = useCallback(() => setOpen(false), []);


  if (!canManage) return null;
  const targets = mergeTargets(apps, app);
  const pick = (fn: () => void) => {
    close();
    fn();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ap-menu${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${app.name}`}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
      >
        <Dots />
      </button>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label={`Actions for ${app.name}`} align="end" id={menuId}>
        <div ref={focusFirst} onKeyDown={menuKeys}>
          <button type="button" role="menuitem" className="cp-sitem" onClick={() => pick(() => rename(app))}>
            <span className="lb">Rename…</span>
          </button>
          {app.is_default ? (
            <p className="ap-menu__note">The default app receives data that names no app, so it can’t be merged or archived.</p>
          ) : (
            <>
              <button type="button" role="menuitem" className="cp-sitem" disabled={targets.length === 0} onClick={() => pick(() => merge(app))}>
                <span className="lb">Merge into…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="cp-sitem"
                onClick={() =>
                  pick(() => {
                    trigger.current?.focus();
                    run(() => archiveApp(project, app.id), doneText("archive", app));
                  })
                }
              >
                <span className="lb">Archive</span>
              </button>
            </>
          )}
        </div>
      </PopMenu>
    </>
  );
}

/**
 * "New app detected" for apps an SDK created in the last 7 days: keep each one (acknowledge) or
 * merge it into an existing app when the name was a typo or a renamed service.
 */
export function NewAppsNotice({ apps, now }: { apps: readonly ManagedApp[]; now: number }) {
  const { project, canManage, merge } = useManage();
  const { pending, run } = useWrite();
  if (apps.length === 0) return null;
  const one = apps.length === 1;
  return (
    <section className="ap-notice ap-notice--new" aria-labelledby="ap-new-title">
      <ObIcon name="info" />
      <div className="ap-notice__body">
        <h2 id="ap-new-title">{one ? "New app detected" : `${apps.length} new apps detected`}</h2>
        <p>
          An SDK sent data with {one ? "an app name" : "app names"} this project didn’t have, so APILens created {one ? "the app" : "them"}. Keep {one ? "it" : "each one"}, or merge
          it into an existing app if the name was a typo or a renamed service.
        </p>
        <ul className="ap-newlist">
          {apps.map((a) => (
            <li key={a.id}>
              <span>
                <b>{a.name}</b>
                {a.slug !== a.name ? <code> {a.slug}</code> : null}
                <span className="ap-muted"> · {originText(a, now)}</span>
              </span>
              {canManage ? (
                <span className="ap-newlist__actions">
                  <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" disabled={pending} onClick={() => run(() => acknowledgeApp(project, a.id), doneText("acknowledge", a))} aria-label={`Keep ${a.name}`}>
                    Keep
                  </button>
                  <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" disabled={pending} onClick={() => merge(a)} aria-label={`Merge ${a.name} into another app`} aria-haspopup="dialog">
                    Merge into…
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Archived, merged and deleted apps, collapsed by default: what each state means now, Restore
 * (deleted ones until their name is released) and, for archived apps, Delete after a confirmation.
 */
export function ArchivedApps({ apps, now }: { apps: readonly ManagedApp[]; now: number }) {
  if (apps.length === 0) return null;
  return (
    <details className="ap-archived">
      <summary>
        Archived <span className="ap-count">{apps.length}</span>
      </summary>
      <p className="ap-muted ap-archived__lead">Archived apps come back on their own when their SDK sends data. Merged apps send new data to their target; deleted apps reject data for 30 days.</p>
      <ul className="ap-archived__list" aria-label="Archived, merged and deleted apps">
        {apps.map((a) => (
          <ArchivedRow key={a.id} app={a} now={now} />
        ))}
      </ul>
    </details>
  );
}

function ArchivedRow({ app, now }: { app: ManagedApp; now: number }) {
  const { project, canManage } = useManage();
  const { pending, run } = useWrite();
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  return (
    <li className="ap-arow">
      <div className="ap-arow__main">
        <p className="ap-arow__name">
          <b>{app.name}</b>
          {app.slug !== app.name ? <code>{app.slug}</code> : null}
          <span className={`ap-state ap-state--${app.state}`}>{STATE_LABEL[app.state]}</span>
        </p>
        <p className="ap-muted">{stateText(app, now)}</p>
      </div>
      {canManage ? (
        <div className="ap-arow__actions">
          {canRestore(app, now) ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" disabled={pending} onClick={() => run(() => restoreApp(project, app.id), doneText("restore", app))} aria-label={`Restore ${app.name}`}>
              Restore
            </button>
          ) : null}
          {canDelete(app) ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm pk-remove" disabled={pending || confirming} aria-expanded={confirming} onClick={() => setConfirming(true)} aria-label={`Delete ${app.name}`}>
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {confirming ? (
        <div
          className="os-confirm pk-confirm ap-confirm"
          role="group"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) setConfirming(false);
          }}
        >
          <p id={titleId}>
            <b>Delete {app.name}?</b> Data sent as <code>{app.slug}</code> is rejected for 30 days. You can restore the app until then; after that its name is free again.
          </p>
          <div className="row">
            <button ref={cancel} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
            <button
              type="button"
              className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`}
              disabled={pending}
              onClick={() => run(() => deleteApp(project, app.id), doneText("delete", app), () => setConfirming(false))}
            >
              Delete app
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** A modal dialog that opens on mount; Escape closes it unless a write is running. */
function useModal(onClose: () => void, pending: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  const onCancel = (e: SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    if (!pending) onClose();
  };
  return { ref, onCancel };
}

function RenameDialog({ app, onClose }: { app: ManagedApp; onClose: () => void }) {
  const { project, announce } = useManage();
  const router = useRouter();
  const [name, setName] = useState(app.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const modal = useModal(onClose, pending);
  const ids = { title: useId(), input: useId(), hint: useId(), err: useId() };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkAppName(name);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (checked.name === app.name) return onClose();
    start(async () => {
      const result = await renameApp(project, app.id, checked.name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      announce({ tone: "ok", text: doneText("rename", { name: checked.name }) });
      onClose();
      router.refresh();
    });
  };

  return (
    <dialog ref={modal.ref} className="ak-dialog" aria-labelledby={ids.title} onCancel={modal.onCancel}>
      <form onSubmit={submit} noValidate>
        <div className="ak-dialog__head">
          <h2 id={ids.title}>Rename {app.name}</h2>
          <p>The display name changes everywhere in APILens.</p>
        </div>
        <div className="ak-dialog__body">
          <div className="ob-f">
            <label className="ob-l" htmlFor={ids.input}>
              Name
            </label>
            <div className={`ob-in${error ? " bad" : ""}`}>
              <input
                id={ids.input}
                value={name}
                maxLength={MAX_APP_NAME + 20}
                autoComplete="off"
                spellCheck={false}
                // biome-ignore lint/a11y/noAutofocus: the dialog's one field
                autoFocus
                aria-invalid={error !== null}
                aria-describedby={`${ids.hint}${error ? ` ${ids.err}` : ""}`}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <p id={ids.hint} className="ak-hint">
              SDKs keep sending <code>{app.slug}</code>; that doesn’t change.
            </p>
            {error ? (
              <p id={ids.err} className="ob-err" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
        <div className="ak-dialog__foot">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
            Save name
          </button>
        </div>
      </form>
    </dialog>
  );
}

function MergeDialog({ app, onClose }: { app: ManagedApp; onClose: () => void }) {
  const { project, apps, announce } = useManage();
  const router = useRouter();
  const targets = mergeTargets(apps, app);
  const [into, setInto] = useState(targets[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const modal = useModal(onClose, pending);
  const ids = { title: useId(), select: useId(), explain: useId() };
  const target = targets.find((t) => t.id === into) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !target) return;
    start(async () => {
      const result = await mergeApp(project, app.id, target.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      announce({ tone: "ok", text: doneText("merge", app, target) });
      onClose();
      router.refresh();
    });
  };

  return (
    <dialog ref={modal.ref} className="ak-dialog" aria-labelledby={ids.title} aria-describedby={ids.explain} onCancel={modal.onCancel}>
      <form onSubmit={submit} noValidate>
        <div className="ak-dialog__head">
          <h2 id={ids.title}>Merge {app.name} into another app</h2>
        </div>
        <div className="ak-dialog__body">
          {targets.length === 0 ? (
            <p className="ak-hint">There’s no other active app to merge into yet.</p>
          ) : (
            <div className="ob-f">
              <label className="ob-l" htmlFor={ids.select}>
                Merge into
              </label>
              <div className="ob-in ap-select">
                <select
                  id={ids.select}
                  value={into}
                  // biome-ignore lint/a11y/noAutofocus: the dialog's one field
                  autoFocus
                  onChange={(e) => {
                    setInto(e.target.value);
                    setError(null);
                  }}
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.slug === t.name ? t.name : `${t.name} (${t.slug})`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <p id={ids.explain} className="os-note ap-explain">
            <ObIcon name="info" />
            <span>{mergeExplainer(app, target)}</span>
          </p>
          {error ? (
            <p className="ob-err" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="ak-dialog__foot">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || !target}>
            Merge app
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The read-only line for readers who may not manage apps; nothing for those who may. */
export function AppsReadOnly() {
  const { canManage } = useManage();
  if (canManage) return null;
  return (
    <p className="ap-notice ap-readonly">
      <ObIcon name="info" />
      <span>{APPS_READ_ONLY}</span>
    </p>
  );
}
