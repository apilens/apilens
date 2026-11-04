"use client";

import { useState } from "react";
import { type SignInNotice, withoutNoticeParams } from "@/lib/sign-in-notice";
import { ObIcon } from "./ob";

/**
 * The dismissible notice above the sign-in form. `role="status"` so screen readers announce it
 * without moving focus. Dismissing also drops `?error=`/`?reason=` from the URL, so a reload does
 * not bring it back.
 */
export function SignInNoticeBanner({ notice }: { notice: SignInNotice }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  const dismiss = () => {
    setOpen(false);
    try {
      window.history.replaceState(window.history.state, "", withoutNoticeParams(window.location.href));
    } catch {
      // Some embedded browsers refuse replaceState; the notice is hidden either way.
    }
  };

  return (
    <div className={`ob-notice ob-notice--${notice.tone}`} role="status" data-code={notice.code}>
      <ObIcon name="info" />
      <p>{notice.text}</p>
      <button type="button" className="ob-notice-x" aria-label="Dismiss" onClick={dismiss}>
        <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
