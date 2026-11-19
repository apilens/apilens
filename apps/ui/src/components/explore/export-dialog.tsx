"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import { logPoll } from "@/lib/explore";
import { EXPORT_LIMITS, exportFileName, toCsv, toJson } from "@/lib/explore-detail";
import { type ExploreQuery, isCustom, routeSearch } from "@/lib/explore-query";
import type { RequestRow } from "@/lib/identity";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";

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

/**
 * Export (#1053, after Supabase's DownloadLogsButton): the requests of every current filter and
 * the range as CSV or JSON, the newest 100, 500, 1,000 or 10,000. The file is written in the
 * browser; its name says the project, the range and when. Headers and bodies are never exported.
 */
export function ExportMenu({ project, query: q, rangeLabel }: { project: string; query: ExploreQuery; rangeLabel: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [limit, setLimit] = useState<number>(1000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    ctl.current = new AbortController();
    try {
      const rows = await readRows(project, q, limit, ctl.current.signal);
      const name = exportFileName(project, isCustom(q) ? rangeLabel : q.range, Date.now(), format);
      download(format === "csv" ? toCsv(rows) : toJson(rows), name, format === "csv" ? "text/csv" : "application/json");
      setOpen(false);
    } catch (x) {
      if ((x as Error).name !== "AbortError") setErr("We couldn’t read the requests just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon"
        aria-haspopup="dialog"
        aria-label="Export requests"
        title="Export requests"
        aria-expanded={open}
        onClick={() => {
          setErr(null);
          setOpen((o) => !o);
        }}
      >
        <Icon name="download" />
      </button>
      <PopMenu
        open={open}
        onClose={() => {
          ctl.current?.abort();
          setOpen(false);
        }}
        triggerRef={trigger}
        label="Export requests"
        role="dialog"
        id={`${id}-pop`}
        align="end"
      >
        <form className="ex-views__form" onSubmit={submit} noValidate>
          <fieldset className="exe-set">
            <legend>Format</legend>
            {(["csv", "json"] as const).map((f) => (
              <label key={f} className="ex-views__check">
                <input type="radio" name={`${id}-format`} checked={format === f} onChange={() => setFormat(f)} />
                {f.toUpperCase()}
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${id}-limit`}>Rows, newest first</label>
          <select id={`${id}-limit`} className="ex-input" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {EXPORT_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString("en-US")}
              </option>
            ))}
          </select>
          <p className="ex-hint">
            The requests of {rangeLabel.toLowerCase()} matching {q.conds.length === 0 ? "no filters" : q.conds.length === 1 ? "1 filter" : `${q.conds.length} filters`}. Headers and bodies are never
            exported.
          </p>
          {err ? (
            <p className="ex-error" role="alert">
              {err}
            </p>
          ) : null}
          <div className="ex-views__actions">
            <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm" disabled={busy}>
              {busy ? "Exporting…" : `Export ${format.toUpperCase()}`}
            </button>
          </div>
        </form>
      </PopMenu>
    </>
  );
}
