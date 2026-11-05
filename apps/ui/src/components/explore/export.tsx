"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cancelRequestExport, startRequestExport } from "@/app/[project]/explore/export-actions";
import type { ExploreState } from "@/lib/explore";
import {
  EXPORT_POLL_MS,
  MAX_EXPORT_ROWS,
  canDownload,
  createdText,
  exportDetail,
  exportError,
  exportPath,
  exportPoll,
  exportScope,
  exportStatus,
  exportTitle,
  filterText,
  forgetExport,
  isActive,
  percent,
  readHistory,
  rememberExport,
} from "@/lib/explore-export";
import { filterQuery } from "@/lib/explore-filters";
import type { RequestExport } from "@/lib/identity";
import { PopMenu } from "../pop-menu";

/** localStorage, or null where the browser blocks it. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Read = { kind: "export"; export: RequestExport } | { kind: "gone" } | { kind: "error"; code: string };

/** Reads one export through the Route Handler; a lapsed session sends the browser to sign in. */
async function readExport(id: string, signal?: AbortSignal): Promise<Read> {
  try {
    const res = await fetch(exportPath(id), { signal, cache: "no-store", headers: { accept: "application/json" } });
    const r = exportPoll(res.status, await res.json().catch(() => null));
    if (r.kind === "expired") {
      window.location.assign(r.next);
      return { kind: "error", code: "session_expired" };
    }
    return r;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return { kind: "error", code: "network_error" };
  }
}

/** The toast's export: the job, or why it could not start or be read. */
type Toast = { export: RequestExport; note: string | null } | { failed: string } | null;

/**
 * Export in the Explore header (#590): a gzip CSV of the request log with the page's range and
 * filters, written by a background job (#579). Start export closes the popover and a toast follows
 * the job (progress, Cancel) until its file is ready to download, or says why it failed, was
 * cancelled or expired. The popover lists the user's recent exports of the project, remembered in
 * this browser, each downloadable while its file lasts (24 hours).
 */
export function ExportMenu({ project, query: q }: { project: string; query: ExploreState }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const ids = { pop: useId(), err: useId() };
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [records, setRecords] = useState<Record<string, Read | undefined>>({});
  const [toast, setToast] = useState<Toast>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setHistory(readHistory(storage(), project)), [project]);

  const keep = useCallback(
    (id: string, r: Read) => {
      if (r.kind === "gone") setHistory(forgetExport(storage(), project, id));
      setRecords((m) => ({ ...m, [id]: r }));
      setNow(Date.now());
    },
    [project],
  );

  // The popover reads every remembered export again when it opens: statuses and links go stale.
  useEffect(() => {
    if (!open || history.length === 0) return;
    const ctl = new AbortController();
    for (const id of history) void readExport(id, ctl.signal).then((r) => keep(id, r), () => {});
    return () => ctl.abort();
    // Only opening starts a read; a history change while open comes from these reads.
  }, [open]);

  // The toast reads its export every second while the job is on its way.
  const toastId = toast && "export" in toast ? toast.export.id : null;
  const toastActive = toast && "export" in toast ? isActive(exportStatus(toast.export, now)) : false;
  useEffect(() => {
    if (!toastId || !toastActive) return;
    let inflight: AbortController | null = null;
    const tick = async () => {
      if (inflight) return;
      inflight = new AbortController();
      try {
        const r = await readExport(toastId, inflight.signal);
        keep(toastId, r);
        if (r.kind === "export") setToast({ export: r.export, note: null });
        else if (r.kind === "gone") setToast({ failed: "That export no longer exists." });
        else setToast((t) => (t && "export" in t ? { ...t, note: "Couldn’t read the export’s progress. We keep trying." } : t));
      } catch {
        // Aborted on unmount.
      } finally {
        inflight = null;
      }
    };
    const id = window.setInterval(tick, EXPORT_POLL_MS);
    return () => {
      window.clearInterval(id);
      inflight?.abort();
    };
  }, [toastId, toastActive, keep]);

  const start = async () => {
    setStarting(true);
    setStartErr(null);
    try {
      const r = await startRequestExport(project, { range: q.range, filters: filterQuery(q.filters) });
      if (!r.ok) {
        setStartErr(r.error);
        return;
      }
      setHistory(rememberExport(storage(), project, r.export.id));
      keep(r.export.id, { kind: "export", export: r.export });
      setToast({ export: r.export, note: null });
      setOpen(false);
      trigger.current?.focus();
    } catch {
      setStartErr(exportError("network_error"));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (x: RequestExport) => {
    const r = await cancelRequestExport(x.id).catch(() => ({ ok: false as const, error: exportError("network_error") }));
    if (r.ok) {
      keep(x.id, { kind: "export", export: r.export });
      setToast({ export: r.export, note: null });
    } else {
      setToast({ export: x, note: `Couldn’t cancel the export. ${r.error}` });
    }
  };

  // A signed link lasts 15 minutes: read the export again so the browser gets a fresh one.
  const download = async (x: RequestExport, fromToast: boolean) => {
    const r = await readExport(x.id);
    keep(x.id, r);
    const fresh = r.kind === "export" ? r.export : null;
    if (fresh && canDownload(fresh, Date.now()) && fresh.download_url) {
      window.location.assign(fresh.download_url);
      if (fromToast) setToast({ export: fresh, note: null });
      return;
    }
    if (fromToast) setToast(fresh ? { export: fresh, note: null } : { failed: r.kind === "gone" ? "That export no longer exists." : `Couldn’t download the export. ${exportError(r.kind === "error" ? r.code : "not_found")}` });
  };

  const zoomed = !!(q.from && q.to) || !!q.at;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ah-btn ah-btn--secondary ah-btn--sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setStartErr(null);
          setOpen((o) => !o);
        }}
      >
        Export
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Export requests to CSV" role="dialog" id={ids.pop}>
        <div className="ex-views__form">
          <p className="ex-views__confirm">
            A gzip CSV of {exportScope(q.range, q.filters)}, newest first, at most {MAX_EXPORT_ROWS.toLocaleString("en-US")} rows. Headers and bodies are never included.
          </p>
          {zoomed ? <p className="ex-hint">It covers the whole range, not the timeline’s zoom.</p> : null}
          {startErr ? (
            <p id={ids.err} className="ex-error" role="alert">
              {startErr}
            </p>
          ) : null}
          <div className="ex-views__actions">
            <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" disabled={starting} aria-describedby={startErr ? ids.err : undefined} onClick={() => void start()}>
              {starting ? "Starting…" : "Start export"}
            </button>
          </div>
        </div>
        {history.length > 0 ? (
          <>
            <hr />
            <p className="menu-label">Recent exports</p>
            <ul className="ex-exports" aria-label="Recent exports">
              {history.map((id) => {
                const r = records[id];
                if (r?.kind === "gone") return null;
                const x = r?.kind === "export" ? r.export : null;
                const s = x ? exportStatus(x, now) : null;
                return (
                  <li key={id} className="ex-exports__row">
                    <div className="ex-exports__text">
                      <span className="ex-exports__title">{x ? filterText(x.filter) : r?.kind === "error" ? "Couldn’t read this export" : "Reading…"}</span>
                      {x && s ? (
                        <span className={`ex-exports__meta${s === "failed" ? " is-err" : ""}`}>
                          {createdText(x.created_at)} · {s === "running" ? `${percent(x)}%` : exportTitle(s).replace(/^Export /, "")}
                        </span>
                      ) : null}
                    </div>
                    {x && canDownload(x, now) ? (
                      <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => void download(x, false)}>
                        Download
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </PopMenu>
      <ExportToast toast={toast} now={now} onCancel={cancel} onDownload={(x) => void download(x, true)} onDismiss={() => setToast(null)} />
    </>
  );
}

/** The export toast: bottom right, one export at a time, announced as it changes. */
function ExportToast({
  toast,
  now,
  onCancel,
  onDownload,
  onDismiss,
}: {
  toast: Toast;
  now: number;
  onCancel: (x: RequestExport) => void;
  onDownload: (x: RequestExport) => void;
  onDismiss: () => void;
}) {
  const x = toast && "export" in toast ? toast.export : null;
  const s = x ? exportStatus(x, now) : null;
  const err = !!toast && (!x || s === "failed" || s === "expired");
  return (
    // Always rendered, so screen readers announce the export as it moves on.
    <div className="ex-toasts" role="status" aria-live="polite">
      {toast ? (
        <div className={`ex-toast${err ? " is-err" : ""}`}>
          <div className="ex-toast__body">
            <p className="ex-toast__title">{x && s ? exportTitle(s) : "Export didn’t start"}</p>
            <p className="ex-toast__detail">{x ? exportDetail(x, now) : "failed" in toast ? toast.failed : ""}</p>
            {x && s === "running" ? (
              <div className="ex-toast__bar" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(x)}>
                <span style={{ width: `${percent(x)}%` }} />
              </div>
            ) : null}
            {toast && "export" in toast && toast.note ? <p className="ex-toast__detail is-err">{toast.note}</p> : null}
            {x && s && (isActive(s) || canDownload(x, now)) ? (
              <div className="ex-toast__actions">
                {isActive(s) ? (
                  <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => onCancel(x)}>
                    Cancel export
                  </button>
                ) : (
                  <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => onDownload(x)}>
                    Download CSV
                  </button>
                )}
              </div>
            ) : null}
          </div>
          <button type="button" className="ob-notice-x" aria-label="Dismiss" onClick={onDismiss}>
            <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
