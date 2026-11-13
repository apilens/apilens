"use client";

import Link from "next/link";
import { useState } from "react";
import { keysPath } from "@/lib/api-keys";
import { ObIcon } from "./ob";
import "./setup-reminder.css";

/**
 * The reminder a project opens with after "I'll do this later" on the install step (#333): no
 * events arrive until the SDK or an exporter sends them with an ingest key, which Access → API keys
 * creates. Dismissing it hides it for this page view.
 */
export function SetupReminder({ project }: { project: string }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="ob-notice ob-notice--warn setup-reminder" role="status">
      <ObIcon name="info" />
      <p>
        Finish setting up: add the SDK or an OpenTelemetry exporter with an ingest key to start seeing requests.{" "}
        <Link className="cp-link" href={keysPath(project)}>
          API keys
        </Link>
      </p>
      <button type="button" className="ob-notice-x" aria-label="Dismiss" onClick={() => setOpen(false)}>
        <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
