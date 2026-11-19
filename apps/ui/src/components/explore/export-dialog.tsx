"use client";

import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { logPoll } from "@/lib/explore";
import { EXPORT_LIMITS, exportFileName, toCsv, toJson } from "@/lib/explore-detail";
import { type ExploreQuery, isCustom, routeSearch } from "@/lib/explore-query";
import type { RequestRow } from "@/lib/identity";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import { Tip } from "./tip";

/** The most rows one read of the log answers. */
const READ_PAGE = 200;

/** Saves `text` as a file the browser downloads. */
export function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The newest `limit` rows of the page's query, read page by page from the log's Route Handler. */
async function readRows(project: string, q: ExploreQuery, limit: number, signal: AbortSignal): Promise<RequestRow[]> {
  const out: RequestRow[] = [];
  let cursor = "";
  do {
    const extra: Record<string, string> = { limit: String(Math.min(READ_PAGE, limit - out.length)) };
    if (cursor) extra.cursor = cursor;
    const res = await fetch(`/api/projects/${encodeURIComponent(project)}/requests${routeSearch(q, extra)}`, { signal, cache: "no-store", headers: { accept: "application/json" } });
    const page = logPoll(res.status, await res.json().catch(() => null));
    if (page.kind === "expired") {
      window.location.assign(page.next);
      return out;
    }
    if (page.kind === "error") throw new Error(page.code);
    out.push(...page.rows);
    cursor = page.older;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

/** Width of the format menu (Supabase's `w-44`); the options step is the popover's usual 280px. */
const MENU_W = 176;

/**
 * Export (#1053, after Supabase's DownloadLogsButton): a small menu, "Download as CSV" and
 * "Download as JSON", then a short step to pick how many of the newest rows (100 to 10,000) and
 * export them. The requests are those of every current filter and the range; the file is written
 * in the browser and its name says the project, the range and when. Headers and bodies are never
 * exported. ⇧E (`triggerRef` click) opens it.
 */
export function ExportMenu({
  project,
  query: q,
  rangeLabel,
  triggerRef,
}: {
  project: string;
  query: ExploreQuery;
  rangeLabel: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const own = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? own;
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"csv" | "json" | null>(null);
  const [limit, setLimit] = useState<number>(1000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = () => {
    ctl.current?.abort();
    setOpen(false);
    setFormat(null);
  };

  // Focus the first menu item on open, and the row count once a format is picked.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const pop = document.getElementById(`${id}-pop`);
      (format ? pop?.querySelector<HTMLElement>("select") : pop?.querySelector<HTMLElement>("[role=menuitem]"))?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, format, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!format) return;
    setBusy(true);
    setErr(null);
    ctl.current = new AbortController();
    try {
      const rows = await readRows(project, q, limit, ctl.current.signal);
      const name = exportFileName(project, isCustom(q) ? rangeLabel : q.range, Date.now(), format);
      download(format === "csv" ? toCsv(rows) : toJson(rows), name, format === "csv" ? "text/csv" : "application/json");
      close();
    } catch (x) {
      if ((x as Error).name !== "AbortError") setErr("We couldn’t read the requests just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // ↑/↓ move between the two items, as a menu.
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const filters = q.conds.length === 0 ? "no filters" : q.conds.length === 1 ? "1 filter" : `${q.conds.length} filters`;

  return (
    <>
      <Tip label="Download" keys={["⇧", "E"]}>
        <button
          ref={trigger}
          type="button"
          className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon"
          aria-haspopup="menu"
          aria-label="Export requests"
          aria-keyshortcuts="Shift+E"
          aria-expanded={open}
          onClick={() => {
            setErr(null);
            setFormat(null);
            setOpen((o) => !o);
          }}
        >
          <Icon name="download" />
        </button>
      </Tip>
      <PopMenu
        open={open}
        onClose={close}
        triggerRef={trigger}
        label={format ? `Download requests as ${format.toUpperCase()}` : "Export requests"}
        role={format ? "dialog" : "menu"}
        id={`${id}-pop`}
        align="end"
        width={format ? 280 : MENU_W}
        className="exe-pop"
      >
        {format === null ? (
          <div ref={menu} className="exe-menu" onKeyDown={onMenuKey}>
            {(["csv", "json"] as const).map((f) => (
              <button key={f} type="button" role="menuitem" className="exe-item" onClick={() => setFormat(f)}>
                <Icon name="download" />
                Download as {f.toUpperCase()}
              </button>
            ))}
          </div>
        ) : (
          <form className="exe-form" onSubmit={submit} noValidate>
            <div className="exe-head">
              <p className="exe-title">Download requests as {format.toUpperCase()}</p>
              <p className="ex-hint">
                {rangeLabel}, {filters}. Headers and bodies are never exported.
              </p>
            </div>
            <label className="exe-field" htmlFor={`${id}-limit`}>
              <span>Rows, newest first</span>
              <select id={`${id}-limit`} className="ex-input" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {EXPORT_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString("en-US")}
                  </option>
                ))}
              </select>
            </label>
            {err ? (
              <p className="ex-error" role="alert">
                {err}
              </p>
            ) : null}
            <div className="exe-actions">
              <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn" onClick={() => setFormat(null)} disabled={busy}>
                Back
              </button>
              <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm ex-tbtn" disabled={busy}>
                {busy ? "Exporting…" : "Export"}
              </button>
            </div>
          </form>
        )}
      </PopMenu>
    </>
  );
}
