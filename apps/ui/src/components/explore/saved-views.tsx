"use client";

import { type FormEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createExploreView, deleteExploreView, updateExploreView } from "@/app/project/[project]/explore/actions";
import { type Cond, OP_LABEL, condString, condWords, fieldDef, valueText } from "@/lib/explore-query";
import {
  MAX_VIEW_NAME,
  PENDING_PREFIX,
  VIEWS_LOAD_FAILED,
  VIEW_EDIT_DENIED,
  activeView,
  canEditView,
  sameSet,
  canSaveFilters,
  checkViewName,
  filtersOfView,
  isPending,
  sortViews,
  upsertView,
  viewFilter,
} from "@/lib/explore-views";
import type { SavedView } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import { useAppNames } from "./app-names";
import { readStored, writeStored } from "./use-stored";

type Said = { tone: "ok" | "err"; text: string } | null;

interface Scope {
  project: string;
  me: string;
  conds: Cond[];
  /** Puts a view's conditions on the page (the range stays). */
  apply: (conds: Cond[]) => void;
  /** Null when the API could not list them. */
  views: SavedView[] | null;
  said: Said;
  save: (name: string, shared: boolean) => void;
  change: (v: SavedView, next: { name: string; shared: boolean; filter?: SavedView["filter"] }, said: string) => void;
  remove: (v: SavedView) => void;
  /** The view last picked from the menu, to notice when its filters change. */
  loaded: string | null;
  setLoaded: (id: string | null) => void;
}

const ViewsScope = createContext<Scope | null>(null);

function useViews(): Scope {
  const scope = useContext(ViewsScope);
  if (!scope) throw new Error("saved views must render inside <SavedViews>");
  return scope;
}

let pendingSeq = 0;

/**
 * The saved views of Explore (#589) for the switcher in the page header and Save view in the
 * filter bar. Every change shows at once (optimistic) and is undone, with the reason, when the API
 * refuses it. `initial` is null when the API could not list the views.
 */
export function SavedViews({
  project,
  me,
  conds,
  apply,
  initial,
  children,
}: { project: string; me: string; conds: Cond[]; apply: (conds: Cond[]) => void; initial: SavedView[] | null; children: ReactNode }) {
  const [views, setViews] = useState<SavedView[] | null>(() => (initial ? sortViews(initial) : null));
  const [said, setSaid] = useState<Said>(null);
  // How many changes are on their way: a new server read must not undo one before it lands.
  const inflight = useRef(0);

  useEffect(() => {
    if (inflight.current === 0) setViews(initial ? sortViews(initial) : null);
  }, [initial]);

  const track = async <T,>(p: Promise<T>): Promise<T> => {
    inflight.current++;
    try {
      return await p;
    } finally {
      inflight.current--;
    }
  };

  const save = useCallback(
    (name: string, shared: boolean) => {
      const at = new Date().toISOString();
      const temp: SavedView = { id: `${PENDING_PREFIX}${++pendingSeq}`, name, surface: "explore", filter: viewFilter(conds), shared, created_by: me, created_at: at, updated_at: at };
      setViews((vs) => upsertView(vs ?? [], temp));
      setSaid(null);
      void track(createExploreView(project, { name, filter: temp.filter, shared })).then((r) => {
        if (r.ok) {
          setViews((vs) => upsertView(vs ?? [], r.view, temp.id));
          setSaid({ tone: "ok", text: shared ? `Saved ${name}, shared with the project.` : `Saved ${name}. Only you see it.` });
        } else {
          setViews((vs) => (vs ?? []).filter((v) => v.id !== temp.id));
          setSaid({ tone: "err", text: `Couldn’t save ${name}. ${r.error}` });
        }
      });
    },
    [project, me, conds],
  );

  const change = useCallback(
    (v: SavedView, next: { name: string; shared: boolean; filter?: SavedView["filter"] }, ok: string) => {
      const optimistic = { ...v, ...next, filter: next.filter ?? v.filter };
      setViews((vs) => upsertView(vs ?? [], optimistic));
      setSaid(null);
      void track(updateExploreView(project, v.id, { name: next.name, filter: optimistic.filter, shared: next.shared })).then((r) => {
        if (r.ok) {
          setViews((vs) => upsertView(vs ?? [], r.view));
          setSaid({ tone: "ok", text: ok });
        } else {
          setViews((vs) => upsertView(vs ?? [], v));
          setSaid({ tone: "err", text: `Couldn’t change ${v.name}. ${r.error}` });
        }
      });
    },
    [project],
  );

  const remove = useCallback(
    (v: SavedView) => {
      setViews((vs) => (vs ?? []).filter((x) => x.id !== v.id));
      setSaid(null);
      void track(deleteExploreView(project, v.id)).then((r) => {
        if (r.ok) {
          setSaid({ tone: "ok", text: `Deleted ${v.name}. The filters stay on until you change them.` });
        } else {
          setViews((vs) => upsertView(vs ?? [], v));
          setSaid({ tone: "err", text: `Couldn’t delete ${v.name}. ${r.error}` });
        }
      });
    },
    [project],
  );

  const [loaded, setLoaded] = useState<string | null>(null);
  return <ViewsScope.Provider value={{ project, me, conds, apply, views, said, save, change, remove, loaded, setLoaded }}>{children}</ViewsScope.Provider>;
}

/**
 * The view switcher in the page header (#589): which saved view the log shows (All requests when
 * no filter is on), a menu of the project's shared views and the user's own, and for the view in
 * use Rename, sharing and Delete. Its creator changes a view; project admins change shared ones;
 * everyone else sees those items disabled with the reason.
 */
export function ViewSwitcher() {
  const { me, conds, apply, views, said, change, remove, setLoaded } = useViews();
  const appName = useAppNames();
  const admin = useCan("capture.manage").allowed;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "rename" | "delete" | "save">("menu");
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const ids = { menu: useId(), name: useId(), err: useId() };

  const list = views ?? [];
  const current = activeView(list, conds);
  const filtered = conds.length > 0;
  const label = current ? current.name : filtered ? "Unsaved filters" : "All requests";
  const editable = current !== null && !isPending(current) && canEditView(current, me, admin);

  const close = useCallback(() => {
    setOpen(false);
    setMode("menu");
  }, []);

  // Keyboard users land on the checked item, or in the field of a form.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const root = document.getElementById(ids.menu);
      const target =
        mode === "rename"
          ? root?.querySelector<HTMLElement>("input")
          : mode === "delete"
            ? root?.querySelector<HTMLElement>("button")
            : (root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? root?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])'));
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, mode, ids.menu]);

  const pick = (next: Cond[], id: string | null = null) => {
    close();
    trigger.current?.focus();
    // A view sets the conditions; the range stays.
    setLoaded(id);
    apply(next);
  };

  const onRename = (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    const checked = checkViewName(name, list, current.created_by ?? "", current.id);
    if (!checked.ok) {
      setNameErr(checked.error);
      return;
    }
    close();
    trigger.current?.focus();
    if (checked.name !== current.name) change(current, { name: checked.name, shared: current.shared }, `Renamed ${current.name} to ${checked.name}.`);
  };

  const menuLabel =
    mode === "rename" ? `Rename ${current?.name ?? "view"}` : mode === "delete" ? `Delete ${current?.name ?? "view"}` : mode === "save" ? "Save these filters as a view" : "Saved views";

  return (
    <div className="ex-views">
      <button
        ref={trigger}
        type="button"
        className={`ex-views__trigger${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : (setMode("menu"), setOpen(true)))}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="ex-tbtn__icon">
          <path d="M4.5 2.5h7v11L8 11l-3.5 2.5z" />
        </svg>
        <span className="ex-tl__sr">View: </span>
        <span className="ex-views__name">{label}</span>
        {current?.shared ? <span className="ex-views__badge">Shared</span> : null}
        <Icon name="chevronDown" />
      </button>
      <p className={`ex-views__said${said?.tone === "err" ? " is-err" : ""}`} role="status" aria-live="polite">
        {said?.text ?? ""}
      </p>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label={menuLabel} role={mode === "menu" ? "menu" : "dialog"} id={ids.menu}>
        {mode === "save" ? (
          <SaveForm
            onDone={() => {
              close();
              trigger.current?.focus();
            }}
          />
        ) : mode === "rename" && current ? (
          <form className="ex-views__form" onSubmit={onRename} noValidate>
            <label htmlFor={ids.name}>View name</label>
            <input
              id={ids.name}
              className="ex-input"
              value={name}
              maxLength={MAX_VIEW_NAME + 20}
              autoComplete="off"
              aria-invalid={nameErr ? true : undefined}
              aria-describedby={nameErr ? ids.err : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setNameErr(null);
              }}
            />
            {nameErr ? (
              <p id={ids.err} className="ex-error" role="alert">
                {nameErr}
              </p>
            ) : null}
            <div className="ex-views__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setMode("menu")}>
                Back
              </button>
              <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm">
                Rename view
              </button>
            </div>
          </form>
        ) : mode === "delete" && current ? (
          <div className="ex-views__form">
            <p className="ex-views__confirm">
              Delete {current.name}?{current.shared ? " It goes for everyone in the project." : ""} The filters stay on until you change them.
            </p>
            <div className="ex-views__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setMode("menu")}>
                Cancel
              </button>
              <button
                type="button"
                className="ah-btn ah-btn--sm ex-btn-danger"
                onClick={() => {
                  close();
                  trigger.current?.focus();
                  remove(current);
                }}
              >
                Delete view
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" role="menuitemradio" aria-checked={!current && !filtered} className="cp-sitem" onClick={() => pick([])}>
              <span className="lb">All requests</span>
              {!current && !filtered ? (
                <span className="sl">
                  <Icon name="check" />
                </span>
              ) : null}
            </button>
            {views === null ? (
              <p className="ex-views__note" role="alert">
                {VIEWS_LOAD_FAILED}
              </p>
            ) : list.length === 0 ? (
              <p className="ex-views__note">No saved views yet. Set filters, then Save view.</p>
            ) : (
              <>
                <p className="menu-label">Saved views</p>
                {list.map((v) => (
                  <button key={v.id} type="button" role="menuitemradio" aria-checked={v === current} className="cp-sitem ex-views__item" onClick={() => pick(filtersOfView(v), v.id)}>
                    <span className="lb">
                      {v.name}
                      <span className="ex-views__sum">{filtersOfView(v).map((c) => condWords(c, { app: appName })).join(" · ") || "No filters"}</span>
                    </span>
                    {v.shared ? <span className="ex-views__badge">Shared</span> : null}
                    {v === current ? (
                      <span className="sl">
                        <Icon name="check" />
                      </span>
                    ) : null}
                  </button>
                ))}
              </>
            )}
            <hr />
            {views !== null && canSaveFilters(list, conds) ? (
              <button type="button" role="menuitem" aria-haspopup="dialog" className="cp-sitem" onClick={() => setMode("save")}>
                <span className="lb">Save current view…</span>
              </button>
            ) : null}
            {filtered ? (
              <button type="button" role="menuitem" className="cp-sitem" onClick={() => pick([])}>
                <span className="lb">Clear all filters</span>
              </button>
            ) : null}
            {current ? (
              <>
                <hr />
                {editable ? null : <p className="ex-views__note">{isPending(current) ? "Saving this view…" : VIEW_EDIT_DENIED}</p>}
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="dialog"
                  className="cp-sitem"
                  disabled={!editable}
                  onClick={() => {
                    setName(current.name);
                    setNameErr(null);
                    setMode("rename");
                  }}
                >
                  <span className="lb">Rename view</span>
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={current.shared}
                  className="cp-sitem"
                  disabled={!editable}
                  onClick={() => {
                    close();
                    trigger.current?.focus();
                    change(
                      current,
                      { name: current.name, shared: !current.shared },
                      current.shared ? `${current.name} is private. Only its creator sees it.` : `${current.name} is shared with everyone in the project.`,
                    );
                  }}
                >
                  <span className="lb">Share with the project</span>
                  {current.shared ? (
                    <span className="sl">
                      <Icon name="check" />
                    </span>
                  ) : null}
                </button>
                <button type="button" role="menuitem" aria-haspopup="dialog" className="cp-sitem" disabled={!editable} onClick={() => setMode("delete")}>
                  <span className="lb">Delete view</span>
                </button>
              </>
            ) : null}
          </>
        )}
      </PopMenu>
    </div>
  );
}

/** The conditions as read-only pills, for the save dialog. */
function Pills({ conds }: { conds: Cond[] }) {
  const appName = useAppNames();
  return (
    <ul className="exp-pills ex-views__pills" aria-label="Filters to save">
      {conds.map((c) => (
        <li key={condString(c)} className={`exp-pill${c.op === "neq" || c.op === "ncontains" ? " is-not" : ""}`}>
          <span className="exp-pill__body">
            <span className="exp-pill__field">{fieldDef(c.field).label}</span>
            <span className="exp-pill__op">{OP_LABEL[c.op]}</span>
            <span className="exp-pill__value">{valueText(c, { app: appName })}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The save form (#589, #1053): the filters on now as pills, a name, and whether the project sees
 * it. `onDone` runs after a save or Cancel.
 */
function SaveForm({ onDone }: { onDone: () => void }) {
  const { me, conds, views, save, setLoaded } = useViews();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = { name: useId(), err: useId(), share: useId() };

  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(ids.name)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [ids.name]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkViewName(name, views ?? [], me);
    if (!checked.ok) {
      setErr(checked.error);
      return;
    }
    setLoaded(null);
    save(checked.name, shared);
    onDone();
  };

  return (
    <form className="ex-views__form" onSubmit={submit} noValidate>
      <Pills conds={conds} />
      <label htmlFor={ids.name}>View name</label>
      <input
        id={ids.name}
        className="ex-input"
        value={name}
        placeholder="Checkout 5xx in production"
        maxLength={MAX_VIEW_NAME + 20}
        autoComplete="off"
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? ids.err : undefined}
        onChange={(e) => {
          setName(e.target.value);
          setErr(null);
        }}
      />
      {err ? (
        <p id={ids.err} className="ex-error" role="alert">
          {err}
        </p>
      ) : null}
      <label className="ex-views__check" htmlFor={ids.share}>
        <input id={ids.share} type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Share with everyone in the project
      </label>
      <div className="ex-views__actions">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm">
          Save view
        </button>
      </div>
    </form>
  );
}

/** Where dismissed "save these filters?" prompts are remembered, per project. */
const DISMISSED_KEY = (project: string) => `apilens.explore.views.dismissed.${project}`;
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
/** A filter set's key, in any order. */
const setKey = (conds: Cond[]) => conds.map(condString).sort().join("\n");

/**
 * The floating view prompts (#1053, after Supabase's views): at 2 or more filters that no view
 * holds, "Save these N filters as a view?" (Save, Dismiss; a dismissal is remembered for that set);
 * when the filters of the view picked last change, "View changed: Update · Save as new".
 */
export function ViewPrompt() {
  const { project, me, conds, views, loaded, setLoaded, change } = useViews();
  const admin = useCan("capture.manage").allowed;
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => setDismissed(readStored(DISMISSED_KEY(project), isList) ?? []), [project]);
  if (views === null) return null;
  const view = loaded ? (views.find((v) => v.id === loaded) ?? null) : null;
  const key = setKey(conds);

  if (view && !sameSet(filtersOfView(view), conds) && conds.length) {
    const editable = !isPending(view) && canEditView(view, me, admin);
    return (
      <div className="ex-prompt" role="status">
        <span>
          View changed: <strong>{view.name}</strong>
        </span>
        {editable ? (
          <button
            type="button"
            className="ah-btn ah-btn--secondary ah-btn--sm"
            onClick={() => change(view, { name: view.name, shared: view.shared, filter: viewFilter(conds) }, `Updated ${view.name}.`)}
          >
            Update
          </button>
        ) : null}
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => (setLoaded(null), setSaving(true))}>
          Save as new
        </button>
        {saving ? <SavePop onDone={() => setSaving(false)} /> : null}
      </div>
    );
  }
  if (saving) {
    return (
      <div className="ex-prompt" role="status">
        <SavePop onDone={() => setSaving(false)} />
      </div>
    );
  }
  if (conds.length < 2 || !canSaveFilters(views, conds) || dismissed.includes(key)) return null;
  return (
    <div className="ex-prompt" role="status">
      <span>Save these {conds.length} filters as a view?</span>
      <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => setSaving(true)}>
        Save
      </button>
      <button
        type="button"
        className="ah-btn ah-btn--ghost ah-btn--sm"
        onClick={() => {
          const next = [...dismissed.filter((k) => k !== key), key].slice(-50);
          setDismissed(next);
          writeStored(DISMISSED_KEY(project), next);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** The save form in a small card over the prompt. */
function SavePop({ onDone }: { onDone: () => void }) {
  return (
    <div className="ex-prompt__form" role="dialog" aria-label="Save these filters as a view">
      <SaveForm onDone={onDone} />
    </div>
  );
}
