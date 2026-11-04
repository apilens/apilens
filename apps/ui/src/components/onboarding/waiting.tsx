"use client";

import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { finishInstallLater } from "@/app/(auth)/onboarding/install/actions";
import type { Method } from "@/lib/instrument";
import {
  BACKOFF_AFTER_MS,
  TROUBLESHOOT_AFTER_MS,
  type WaitState,
  createPoller,
  errorState,
  expectedEndpoint,
  ingestStatusPath,
  pollResult,
  statusLine,
  testRequestCurl,
} from "@/lib/waiting";
import { CodeBlock } from "./install";
import { ObIcon, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue, useOnboardingToast } from "./progress";
import "./install.css";
import "./waiting.css";

const LEAVE_FAILED = "We couldn’t finish setup. Try again in a moment.";

/** The ingest URL's host, for the firewall hint. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * "Waiting for your first request" (#334), step 5: polls the project's ingest status (the Route
 * Handler for `GET /projects/{slug}/ingest-status`, #287) every 3 s, every 10 s after two minutes,
 * and not at all while the tab is hidden. A live status line says what it is doing. After three
 * minutes without a request it shows troubleshooting: the key, the base URL, the network, and a
 * curl that sends a test request with the key. As soon as a request is in, it goes on to the
 * first data. "Open the project anyway" finishes onboarding on the project with the setup reminder.
 */
export function Waiting({
  step = 4,
  reached = step,
  project,
  method,
  appId,
  ingestUrl,
}: Partial<StepProps> & {
  project: { slug: string; name: string };
  method: Method;
  appId: string;
  ingestUrl: string;
}) {
  const [state, setState] = useState<WaitState>("waiting");
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [trouble, setTrouble] = useState(false);
  const [leaving, startLeaving] = useTransition();
  const { go, pending } = useOnboardingContinue(reached);
  const toast = useOnboardingToast();
  // The latest `go`, for the poller's callback (it is created once per project).
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  }, [go]);

  useEffect(() => {
    const t = setTimeout(() => setTrouble(true), TROUBLESHOOT_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let last: WaitState = "waiting";
    const poller = createPoller({
      poll: async (signal) => {
        const res = await fetch(ingestStatusPath(project.slug), { signal, cache: "no-store", headers: { accept: "application/json" } });
        return pollResult(res.status, await res.json().catch(() => null));
      },
      onResult: (result, elapsed) => {
        if (result.kind === "expired") {
          window.location.assign(result.next);
          return false;
        }
        if (result.kind === "error") {
          last = errorState(result.code);
          setState(last);
          return last !== "forbidden";
        }
        setCheckedAt(new Date());
        if (result.status.received) {
          setState("received");
          goRef.current("first-data", "/onboarding/first-data");
          return false;
        }
        last = elapsed >= BACKOFF_AFTER_MS ? "slow" : "waiting";
        setState(last);
        return true;
      },
      onPause: (paused) => setState(paused ? "paused" : last === "error" ? "waiting" : last),
    });
    const onVisibility = () => (document.hidden ? poller.pause() : poller.resume());
    document.addEventListener("visibilitychange", onVisibility);
    poller.start(document.hidden);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
    };
  }, [project.slug]);

  const openAnyway = () =>
    startLeaving(async () => {
      try {
        const res = await finishInstallLater(project.slug);
        if (!res.ok) toast(res.error);
      } catch (err) {
        unstable_rethrow(err);
        toast(LEAVE_FAILED);
      }
    });

  const received = state === "received";
  const live = state === "waiting" || state === "slow";
  const busy = leaving || pending || received;
  const endpoint = expectedEndpoint(method, ingestUrl);
  const curl = { id: "curl", title: "Send a test request", code: testRequestCurl(ingestUrl, appId) };

  return (
    <ObShell
      eyebrow="02:41 AM"
      headline={["Now send it", "one request."]}
      body="Run your service and call any endpoint. The first request shows up here within seconds."
      receipt={
        <>
          status · <b>live</b> · no refresh needed
        </>
      }
      progress={90}
      step={step}
      reached={reached}
      badge="live"
      title="Waiting for your first request"
      lead={
        <>
          Start <b>{project.name}</b> with the snippet and send it any request. We’ll move on as soon as it arrives.
        </>
      }
      footer={
        <div className="ob-foot">
          <Link className="ah-btn ah-btn--ghost" href="/onboarding/install">
            <ObIcon name="back" />
            Back
          </Link>
          <span className="sp" />
          <button type="button" className="ah-btn ah-btn--secondary" onClick={openAnyway} disabled={busy} aria-disabled={busy || undefined}>
            Open the project anyway
            <ObIcon name="next" />
          </button>
        </div>
      }
    >
      <div className="ob-card wt-card">
        <div className="hd">
          <span className={`ob-pulse${live ? "" : " wt-still"}`} aria-hidden="true" />
          <span>
            Listening for <b>{appId}</b>
          </span>
          <small>{checkedAt ? `checked ${checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "starting"}</small>
        </div>
        <div className="ob-check">
          <span className="st ok">
            <ObIcon name="done" />
          </span>
          <div>
            <b>Ingest key created</b>
            <small>named “Onboarding”, ingest only</small>
          </div>
        </div>
        <div className={`ob-check${received ? "" : " wt-now"}`}>
          <span className={`st ${received ? "ok" : state === "forbidden" ? "bad" : live ? "spin" : "todo"}`}>{received ? <ObIcon name="done" /> : null}</span>
          <div>
            <b>First request</b>
            <small className="wt-line" role="status" aria-live="polite">
              {statusLine(state)}
            </small>
          </div>
        </div>
        <div className="ob-check todo">
          <span className="st todo" />
          <div>
            <b>First data</b>
            <small>opens as soon as the request lands</small>
          </div>
        </div>
      </div>

      {trouble && !received ? (
        <section className="ob-f wt-trouble" aria-labelledby="wt-trouble-h">
          <h2 className="ob-l" id="wt-trouble-h">
            Still nothing? Check these
            <small>three minutes in</small>
          </h2>
          <ol className="wt-list">
            <li>
              <b>Has the service handled a request?</b>
              <span>{method === "sdk" ? "The SDK reports the requests your service serves." : "The exporter sends spans for the requests your service serves."} Call any endpoint once it has restarted with the snippet.</span>
            </li>
            <li>
              <b>Is the key pasted?</b>
              <span>
                The service’s environment needs {method === "sdk" ? <code>APILENS_API_KEY</code> : <code>OTEL_EXPORTER_OTLP_HEADERS</code>} set to the key from the install step. Lost it?{" "}
                <Link className="cp-link" href="/onboarding/install">
                  Create a new key
                </Link>
              </span>
            </li>
            <li>
              <b>Is the base URL right?</b>
              <span>
                {method === "sdk" ? "The SDK’s base URL" : <code>OTEL_EXPORTER_OTLP_ENDPOINT</code>} must be <code>{endpoint}</code>.
              </span>
            </li>
            <li>
              <b>Can the service reach APILens?</b>
              <span>
                A firewall or proxy must allow outbound HTTPS to <code>{hostOf(ingestUrl)}</code>.
              </span>
            </li>
            <li>
              <b>Send a test request</b>
              <span>
                From the same machine, with <code>APILENS_API_KEY</code> set. <code>{`{"accepted":1}`}</code> means the key and the network are fine: look at the setup in your code.
              </span>
            </li>
          </ol>
          <CodeBlock snippet={curl} />
        </section>
      ) : null}
    </ObShell>
  );
}
