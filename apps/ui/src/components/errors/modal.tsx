"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, createContext, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { markStatusExpected } from "@/app/[project]/errors/actions";
import { useCan } from "@/lib/permissions";

/** Lets an action inside the modal report its outcome above the modal's content. */
const Announce = createContext<(message: string) => void>(() => {});

/**
 * One status code's detail as a modal dialog (#594), open while the URL has `?code=`. Closing it
 * (the Close button, Escape or a click outside) goes to `closeHref`, the page without the code.
 * Its children are rendered on the server; the modal keeps the outcome of "mark as expected"
 * across the page reading itself again.
 */
export function ErrorModal({ title, lead, closeHref, children }: { title: string; lead: string; closeHref: string; children: ReactNode }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const close = () => router.push(closeHref, { scroll: false });

  return (
    <dialog
      ref={ref}
      className="er-modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="er-modal__in">
        <div className="er-modal__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="er-modal__lead">{lead}</p>
          </div>
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close}>
            Close
          </button>
        </div>
        <p className="er-done" role="status">
          {message}
        </p>
        <Announce.Provider value={setMessage}>{children}</Announce.Provider>
      </div>
    </dialog>
  );
}

/**
 * "Mark as expected" for one endpoint in the modal's Details view, with a confirmation first.
 * Holders of `capture.manage` can mark; everyone else is told who can. After marking, the page
 * reads itself again, so the counts everywhere leave the code out for this endpoint.
 */
export function MarkExpected({ project, method, path, code }: { project: string; method: string; path: string; code: number }) {
  const manage = useCan("capture.manage").allowed;
  const router = useRouter();
  const announce = useContext(Announce);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = { title: useId(), body: useId() };

  if (!manage) return <p className="er-ep__note">Only project admins can mark {code} as expected for this endpoint.</p>;

  if (!confirming) {
    return (
      <div className="er-ep__actions">
        <button
          type="button"
          className="ah-btn ah-btn--secondary ah-btn--sm"
          onClick={() => {
            setFailure(null);
            setConfirming(true);
          }}
        >
          Mark {code} as expected
        </button>
      </div>
    );
  }

  const confirm = () => {
    setFailure(null);
    startTransition(async () => {
      const result = await markStatusExpected(project, method, path, code);
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      announce(`${code} is now expected for ${method} ${path}. Its ${code} responses no longer count as errors.`);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <div className="er-confirm" role="group" aria-labelledby={ids.title} aria-describedby={ids.body}>
      <p id={ids.title} className="er-confirm__title">
        Mark {code} as expected for {method} {path}?
      </p>
      <p id={ids.body} className="er-confirm__body">
        Its {code} responses stop counting as errors on every dashboard, in every app of this project. You can change this later in the endpoint’s settings.
      </p>
      {failure ? (
        <p className="er-err" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="er-ep__actions">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setConfirming(false)} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} aria-disabled={pending || undefined} onClick={() => (pending ? undefined : confirm())}>
          Mark as expected
        </button>
      </div>
    </div>
  );
}
