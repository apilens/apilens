"use client";

import { unstable_rethrow } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { type InstallKey, createInstallKey, finishInstallLater } from "@/app/(auth)/onboarding/install/actions";
import { maskedKey } from "@/lib/api-keys";
import { type SavedKey, type Snippet, snippetsFor } from "@/lib/install";
import { type Method, languageOf } from "@/lib/instrument";
import { BackNext, ObIcon, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue, useOnboardingToast } from "./progress";
import "./install.css";

const FAILED = "We couldn’t create your key. Try again in a moment.";

/** Copies text; `copied` flips back after a moment, `failed` asks for the keyboard instead. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  return { copied, failed, copy };
}

export function CodeBlock({ snippet }: { snippet: Snippet }) {
  const { copied, failed, copy } = useCopy();
  return (
    <div className="ob-code ins-code">
      <div className="hd">
        <ObIcon name="code" />
        <span>{snippet.title}</span>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => copy(snippet.code)} aria-label={`Copy ${snippet.title}`}>
          {copied ? "Copied" : failed ? "Select and copy" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>{snippet.code}</pre>
    </div>
  );
}

/** The new key, shown once with a copy button. */
function RawKey({ apiKey }: { apiKey: InstallKey }) {
  const { copied, failed, copy } = useCopy();
  const field = useRef<HTMLInputElement>(null);
  const onCopy = async () => {
    await copy(apiKey.key);
  };
  useEffect(() => {
    if (failed) field.current?.select();
  }, [failed]);
  return (
    <>
      <div className="ob-in ro ins-key">
        <input ref={field} aria-labelledby="ins-key-label" value={apiKey.key} readOnly spellCheck={false} aria-describedby="ins-key-once" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCopy} aria-label="Copy API key">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="ins-status" role="status" aria-live="polite">
        {copied ? "Copied to the clipboard." : failed ? "Couldn’t copy. The key is selected: copy it with your keyboard." : ""}
      </p>
      <div className="ob-hint warn" id="ins-key-once">
        <ObIcon name="info" />
        <span>
          This is the only time the full key is shown. Store it in your secret manager now: it’s masked once you leave this page.
        </span>
      </div>
    </>
  );
}

/**
 * "Install" (#333), step 4: on the first visit it creates an ingest key named "Onboarding" on the
 * project (its id is saved in the onboarding answers, the raw key is not) and shows it once, with
 * a copy button, and the snippets for the language and method picked on the instrument step (#332)
 * filled in with it, the app id and `APILENS_PUBLIC_INGEST_URL`. On a revisit the raw key is gone:
 * the key shows masked and "Create a new key" makes another. Continue goes on to wait for the
 * first request; "I'll do this later" finishes onboarding and opens the project with a reminder.
 */
export function Install({
  step = 3,
  reached = step,
  project,
  language,
  method,
  appId,
  ingestUrl,
  saved,
}: Partial<StepProps> & {
  project: { slug: string; name: string };
  language: string;
  method: Method;
  appId: string;
  ingestUrl: string;
  saved: SavedKey;
}) {
  const [apiKey, setApiKey] = useState<InstallKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  const [leaving, startLeaving] = useTransition();
  const { go, pending } = useOnboardingContinue(reached);
  const toast = useOnboardingToast();
  // Survives React's development double mount, so the first visit creates one key, not two.
  const started = useRef(false);

  const create = useCallback(
    () =>
      startCreating(async () => {
        setError(null);
        try {
          const res = await createInstallKey(project.slug);
          if (res.ok) setApiKey(res.key);
          else setError(res.error);
        } catch (err) {
          unstable_rethrow(err);
          setError(FAILED);
        }
      }),
    [project.slug],
  );

  useEffect(() => {
    if (saved.state !== "none" || started.current) return;
    started.current = true;
    create();
  }, [saved.state, create]);

  const later = () =>
    startLeaving(async () => {
      try {
        const res = await finishInstallLater(project.slug);
        if (!res.ok) toast(res.error);
      } catch (err) {
        unstable_rethrow(err);
        toast("We couldn’t finish setup. Try again in a moment.");
      }
    });

  const snippets = snippetsFor({ language, method, apiKey: apiKey?.key, appId, ingestUrl });
  const lang = languageOf(language)?.label ?? language;
  const how = method === "sdk" ? `the ${lang} SDK` : `OpenTelemetry for ${lang}`;
  const busy = creating || pending || leaving;

  let keyBody: ReactNode;
  if (apiKey) keyBody = <RawKey apiKey={apiKey} />;
  else if (creating || (saved.state === "none" && !error)) {
    keyBody = (
      <div className="ob-note" role="status">
        <ObIcon name="redo" />
        <span>Creating your ingest key…</span>
      </div>
    );
  } else if (error) {
    keyBody = (
      <>
        <p className="ob-err" role="alert">
          {error}
        </p>
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ins-new" onClick={create}>
          <ObIcon name="redo" />
          Try again
        </button>
      </>
    );
  } else {
    const active = saved.state === "active";
    keyBody = (
      <>
        {active ? (
          <div className="ob-in ro ins-key">
            <input aria-labelledby="ins-key-label" value={maskedKey(saved.prefix)} readOnly aria-describedby="ins-key-gone" />
          </div>
        ) : null}
        <div className="ob-hint" id="ins-key-gone">
          <ObIcon name="info" />
          <span>
            {active
              ? "The full key was shown once, when it was created. Use the copy you stored, or create a new key."
              : saved.state === "unknown"
                ? "We couldn’t check the key created earlier. Use the copy you stored, or create a new key."
                : "The key created earlier was revoked or has expired. Create a new key to continue."}
          </span>
        </div>
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ins-new" onClick={create}>
          <ObIcon name="redo" />
          Create a new key
        </button>
      </>
    );
  }

  return (
    <ObShell
      eyebrow="02:36 AM"
      headline={["One key,", "one middleware."]}
      body="Paste the snippet, run your service and send it a request. We’ll be watching for it."
      receipt={
        <>
          key · <b>ingest only</b> · shown once
        </>
      }
      progress={75}
      step={step}
      reached={reached}
      badge="code"
      title="Install"
      lead={
        <>
          Send <b>{project.name}</b>’s requests to APILens with {how}.
        </>
      }
      footer={<BackNext back="/onboarding/instrument" nextLabel="Continue" disabled={busy} loading={pending} onNext={() => go("waiting", "/onboarding/waiting")} />}
      below={
        <>
          Not ready to change code?{" "}
          <button type="button" className="cp-link ins-later" onClick={later} disabled={busy}>
            I’ll do this later
          </button>
        </>
      }
    >
      <div className="ob-f">
        <p className="ob-l" id="ins-key-label">
          Ingest key<small>named “Onboarding”, can only send events</small>
        </p>
        {keyBody}
      </div>
      <div className="ob-f ins-snippets">
        <p className="ob-l">
          {method === "sdk" ? "Add the SDK" : "Point your exporter at APILens"}
          <small>app id {appId}</small>
        </p>
        {snippets.map((s) => (
          <CodeBlock key={s.id} snippet={s} />
        ))}
      </div>
    </ObShell>
  );
}
