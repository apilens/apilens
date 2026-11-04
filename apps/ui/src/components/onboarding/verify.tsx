"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BackNext, ObIcon, ObShell } from "./ob";

/** Six boxes over one real input, so typing, paste, autofill and one-time-code all work. */
export function Verify() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get("email") || "amit@motadata.com";
  const signin = params.get("flow") === "signin";
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  // The resend cooldown starts where `/api/auth/email/start` said (`retry_after`, #313).
  const [left, setLeft] = useState(() => {
    const n = Number(params.get("retry_after"));
    return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : 42;
  });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const done = code.length === 6;
  const go = () => {
    if (!done) return;
    setSending(true);
    router.push(signin ? "/platform/incidents" : "/onboarding/about");
  };
  const mail = (host: string) => `https://${host}`;
  const cell = (i: number) => (
    <span key={i} className={i === code.length ? "cur" : undefined}>
      {code[i] ?? ""}
    </span>
  );

  return (
    <ObShell
      eyebrow="02:19 AM"
      headline={["Everyone has", "a theory. Nobody", "has proof."]}
      body="“Was it the deploy?” “Is it the database?” “It works for me.”"
      receipt={
        <>
          #incident · <b>47</b> messages · <b>0</b> answers
        </>
      }
      progress={16.67}
      step={signin ? undefined : 0}
      badge="mail"
      title="Check your inbox"
      lead={
        <>
          Enter the 6-digit code we sent to <b>{email}</b>.
        </>
      }
      footer={<BackNext back={signin ? "/sign-in" : "/sign-up"} nextLabel="Verify" disabled={!done} loading={sending} onNext={go} />}
    >
      <div className="ob-code6" onClick={() => input.current?.focus()}>
        {[0, 1, 2].map(cell)}
        <span className="gap" />
        {[3, 4, 5].map(cell)}
        <input
          ref={input}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && go()}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          aria-label="6-digit code"
        />
      </div>
      <div className="ob-note">
        <ObIcon name="info" />
        <span>Paste the whole code, or open the link in the email.</span>
      </div>
      <div className="ob-actions">
        <a className="ah-btn ah-btn--secondary ah-btn--sm" href={mail("mail.google.com")} target="_blank" rel="noreferrer">
          <ObIcon name="out" />
          Open Gmail
        </a>
        <a className="ah-btn ah-btn--secondary ah-btn--sm" href={mail("outlook.live.com")} target="_blank" rel="noreferrer">
          <ObIcon name="out" />
          Open Outlook
        </a>
        <button type="button" className={`ah-btn ah-btn--ghost ah-btn--sm${left > 0 ? " is-disabled" : ""}`} onClick={() => setLeft(42)} disabled={left > 0}>
          <ObIcon name="redo" />
          {left > 0 ? `Resend in 0:${String(left).padStart(2, "0")}` : "Resend code"}
        </button>
      </div>
    </ObShell>
  );
}
