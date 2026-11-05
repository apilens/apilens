"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { createExploreView, deleteExploreView, updateExploreView } from "@/app/[project]/explore/actions";
import { type ExploreState, exploreHref } from "@/lib/explore";
import { NO_FILTERS, activeCount } from "@/lib/explore-filters";
import {
  MAX_VIEW_NAME,
  PENDING_PREFIX,
  VIEWS_LOAD_FAILED,
  VIEW_EDIT_DENIED,
  activeView,
  canEditView,
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

type Said = { tone: "ok" | "err"; text: string } | null;

interface Scope {
  project: string;
  me: string;
  query: ExploreState;
  /** Null when the API could not list them. */
  views: SavedView[] | null;
  said: Said;
  save: (name: string, shared: boolean) => void;
  change: (v: SavedView, next: { name: string; shared: boolean }, said: string) => void;
  remove: (v: SavedView) => void;
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
export function SavedViews({ project, me, query, initial, children }: { project: string; me: string; query: ExploreState; initial: SavedView[] | null; children: ReactNode }) {
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
      const temp: SavedView = { id: `${PENDING_PREFIX}${++pendingSeq}`, name, surface: "explore", filter: viewFilter(query.filters), shared, created_by: me, created_at: at, updated_at: at };
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
    [project, me, query.filters],
  );

  const change = useCallback(
    (v: SavedView, next: { name: string; shared: boolean }, ok: string) => {
      const optimistic = { ...v, ...next };
      setViews((vs) => upsertView(vs ?? [], optimistic));
      setSaid(null);
      void track(updateExploreView(project, v.id, { name: next.name, filter: v.filter, shared: next.shared })).then((r) => {
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

  return <ViewsScope.Provider value={{ project, me, query, views, said, save, change, remove }}>{children}</ViewsScope.Provider>;
}

/**
 * The view switcher in the page header (#589): which saved view the log shows (All requests when
 * no filter is on), a menu of the project's shared views and the user's own, and for the view in
 * use Rename, sharing and Delete. Its creator changes a view; project admins change shared ones;
 * everyone else sees those items disabled with the reason.
 */
export function ViewSwitcher() {
  const { project, me, query: q, views, said, change, remove } = useViews();
  const admin = useCan("capture.manage").allowed;
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "rename" | "delete">("menu");
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [, startNav] = useTransition();
  const ids = { menu: useId(), name: useId(), err: useId() };

  const list = views ?? [];
  const current = activeView(list, q.filters);
  const filtered = activeCount(q.filters) > 0;
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

  const pick = (filters: ExploreState["filters"]) => {
    close();
    trigger.current?.focus();
    // A view sets the filters; the range stays, the timeline's zoom starts over.
    const href = exploreHref(project, { range: q.range, filters });
    startNav(() => router.push(href, { scroll: false }));
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

  const menuLabel = mode === "rename" ? `Rename ${current?.name ?? "view"}` : mode === "delete" ? `Delete ${current?.name ?? "view"}` : "Saved views";

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
        <Icon name="layers" />
        <span className="ex-tl__sr">View: </span>
        <span className="ex-views__name">{label}</span>
        {current?.shared ? <span className="ex-views__badge">Shared</span> : null}
        <Icon name="chevronDown" />
      </button>
      <p className={`ex-views__said${said?.tone === "err" ? " is-err" : ""}`} role="status" aria-live="polite">
        {said?.text ?? ""}
      </p>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label={menuLabel} role={mode === "menu" ? "menu" : "dialog"} id={ids.menu}>
        {mode === "rename" && current ? (
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
            <button type="button" role="menuitemradio" aria-checked={!current && !filtered} className="cp-sitem" onClick={() => pick(NO_FILTERS)}>
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
                  <button key={v.id} type="button" role="menuitemradio" aria-checked={v === current} className="cp-sitem" onClick={() => pick(filtersOfView(v))}>
                    <span className="lb">{v.name}</span>
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

/**
 * Save view in the filter bar (#589): names the filters on now as a view, private or shared with
 * the project. Shown while some filters are on that no saved view holds.
 */
export function SaveView() {
  const { me, query: q, views, save } = useViews();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = { form: useId(), name: useId(), err: useId(), share: useId() };

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => document.getElementById(ids.name)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, ids.name]);

  if (views === null || !canSaveFilters(views, q.filters)) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkViewName(name, views, me);
    if (!checked.ok) {
      setErr(checked.error);
      return;
    }
    setOpen(false);
    setName("");
    setShared(false);
    save(checked.name, shared);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ah-btn ah-btn--ghost ah-btn--sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setErr(null);
          setOpen((o) => !o);
        }}
      >
        Save view
      </button>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label="Save these filters as a view" role="dialog" id={ids.form}>
        <form className="ex-views__form" onSubmit={submit} noValidate>
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
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm">
              Save view
            </button>
          </div>
        </form>
      </PopMenu>
    </>
  );
}
