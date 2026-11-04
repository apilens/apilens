"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { encode } from "uqr";
import { confirmTwoFactor, disableTwoFactor, regenerateBackupCodes, startTwoFactor } from "@/app/settings/two-factor-actions";
import type { TwoFactorStatus } from "@/lib/identity";
import { signOut } from "@/lib/sign-out";
import { cleanBackupCode, cleanTotp, isBackupCode } from "@/lib/two-factor";
import {
  BACKUP_CODES_FILE,
  LOW_BACKUP_CODES,
  backupCodesLeft,
  backupCodesText,
  enabledSince,
  groupSecret,
} from "@/lib/two-factor-settings";
import { ObIcon } from "../onboarding/ob";
import "./two-factor.css";

const SECURITY_PATH = "/settings/security";

type Flow = "enable" | "disable" | "regenerate" | null;

/**
 * Security → Two-factor (#342): whether two-factor authentication is on, since when and how many
 * backup codes are left, with the three flows that change it, each in a modal dialog: turning it
 * on (QR code and secret, a code from the app, then the backup codes shown once), turning it off
 * (a code or a backup code) and regenerating the backup codes (a code, then the new ones).
 */
export function TwoFactorSettings({ initial, email }: { initial: TwoFactorStatus; email: string | null }) {
  const [status, setStatus] = useState(initial);
  const [flow, setFlow] = useState<Flow>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const low = status.enabled && status.backup_codes_remaining <= LOW_BACKUP_CODES;

  const done = (next: TwoFactorStatus, message: string) => {
    setStatus(next);
    setNotice(message);
    setFlow(null);
  };

  return (
    <section className="tf-card" aria-labelledby="tf-title">
      <div className="tf-card__row">
        <span className="tf-card__ic" aria-hidden="true">
          <ObIcon name="lock" />
        </span>
        <div className="tf-card__t">
          <h2 id="tf-title">
            Two-factor authentication
            <span className={`ah-badge ${status.enabled ? "ah-badge--ok" : "tf-off"}`} data-testid="tf-state">
              {status.enabled ? "On" : "Off"}
            </span>
          </h2>
          {status.enabled ? (
            <p>
              {["Signing in asks for a code from your authenticator app", enabledSince(status.confirmed_at)].filter(Boolean).join(" ")}.{" "}
              <span className={low ? "tf-low" : undefined} data-testid="tf-remaining">
                {backupCodesLeft(status.backup_codes_remaining)}.
              </span>
            </p>
          ) : (
            <p>Add a second step to signing in: a 6-digit code from an authenticator app like 1Password, Google Authenticator or Authy.</p>
          )}
        </div>
        <div className="tf-card__act">
          {status.enabled ? (
            <>
              <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => setFlow("regenerate")}>
                Regenerate backup codes
              </button>
              <button type="button" className="ah-btn ah-btn--sm tf-btn-outline-danger" onClick={() => setFlow("disable")}>
                Turn off
              </button>
            </>
          ) : (
            <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => setFlow("enable")}>
              Turn on
            </button>
          )}
        </div>
      </div>
      {low ? (
        <p className="tf-warn">
          <ObIcon name="info" />
          <span>You’re running low on backup codes. Regenerate them so you can still sign in if you lose your device.</span>
        </p>
      ) : null}
      <p className="tf-notice" role="status" aria-live="polite">
        {notice ?? ""}
      </p>

      {flow === "enable" ? (
        <EnableDialog email={email} onClose={() => setFlow(null)} onDone={(s) => done(s, "Two-factor authentication is on.")} />
      ) : null}
      {flow === "disable" ? (
        <DisableDialog onClose={() => setFlow(null)} onDone={(s) => done(s, "Two-factor authentication is off.")} />
      ) : null}
      {flow === "regenerate" ? (
        <RegenerateDialog email={email} onClose={() => setFlow(null)} onDone={(s) => done(s, "New backup codes saved. The old ones no longer work.")} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialog frame

/**
 * A native modal `<dialog>`: focus moves into it and stays there, Escape and the close button
 * call `onClose` unless `locked` (the backup codes must be acknowledged first).
 */
function Dialog({ title, children, onClose, locked = false }: { title: string; children: ReactNode; onClose: () => void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const latest = useRef({ locked, onClose });
  useEffect(() => {
    latest.current = { locked, onClose };
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      if (!latest.current.locked) latest.current.onClose();
    };
    d.addEventListener("cancel", cancel);
    return () => {
      d.removeEventListener("cancel", cancel);
      if (d.open) d.close();
    };
  }, []);

  return (
    <dialog ref={ref} className="tf-dialog" aria-labelledby="tf-dialog-title">
      <div className="tf-dialog__head">
        <h2 id="tf-dialog-title">{title}</h2>
        {locked ? null : (
          <button type="button" className="tf-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces

/** The six-cell code entry of the sign-in step, submitting itself once six digits are in. */
function CodeField({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
  describedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  invalid: boolean;
  disabled: boolean;
  describedBy?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);
  const cell = (i: number) => (
    <span key={i} className={i === value.length ? "cur" : undefined}>
      {value[i] ?? ""}
    </span>
  );
  return (
    <div className={`ob-code6 tf-code${invalid ? " bad" : ""}`} onClick={() => input.current?.focus()}>
      {[0, 1, 2].map(cell)}
      <span className="gap" />
      {[3, 4, 5].map(cell)}
      <input
        ref={input}
        value={value}
        onChange={(e) => {
          const next = cleanTotp(e.target.value);
          onChange(next);
          if (next.length === 6 && value.length < 6) onComplete(next);
        }}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        disabled={disabled}
        aria-label="6-digit code"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    </div>
  );
}

function ErrorLine({ id, text }: { id: string; text: string | null }) {
  return (
    <div aria-live="polite">
      {text ? (
        <p id={id} className="ob-err" role="alert">
          {text}
        </p>
      ) : null}
    </div>
  );
}

/** The `otpauth://` URI as a QR code, drawn as one SVG path (dark on white in both themes). */
function QrCode({ uri }: { uri: string }) {
  const { size, d } = useMemo(() => {
    const qr = encode(uri, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: qr.size, d: path };
  }, [uri]);
  return (
    <svg className="tf-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Copies `text`; says so for a moment. */
function useCopy(): [string | null, (key: string, text: string) => Promise<void>] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(`${key}:failed`);
    }
  };
  return [copied, copy];
}

/**
 * The backup codes, shown once: copy, download as `.txt`, and an "I saved them" checkbox that
 * unlocks Done. Until then the dialog cannot be dismissed.
 */
function BackupCodesStep({ codes, email, lead, onDone }: { codes: string[]; email: string | null; lead: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, copy] = useCopy();
  const done = useRef<HTMLButtonElement>(null);

  const download = () => {
    const url = URL.createObjectURL(new Blob([backupCodesText(codes, email)], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = BACKUP_CODES_FILE;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <>
      <div className="tf-dialog__body">
        <p className="tf-lead">{lead}</p>
        <p className="tf-once">
          <ObIcon name="eye" />
          <span>You won’t see these codes again. Each one works once.</span>
        </p>
        <ol className="tf-codes" aria-label="Backup codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="tf-codes__act">
          <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => copy("codes", codes.join("\n"))}>
            {copied === "codes" ? "Copied" : "Copy codes"}
          </button>
          <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={download}>
            Download .txt
          </button>
        </div>
        {copied === "codes:failed" ? <p className="ob-err">Couldn’t copy. Download the codes or write them down instead.</p> : null}
        <label className="ob-keep tf-saved">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => {
              setSaved(e.target.checked);
              if (e.target.checked) requestAnimationFrame(() => done.current?.focus());
            }}
          />
          <span>I saved my backup codes somewhere safe</span>
        </label>
      </div>
      <div className="tf-dialog__foot">
        <button ref={done} type="button" className="ah-btn ah-btn--primary ah-btn--sm" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Turn on

type Enrollment = { secret: string; otpauthUri: string };

function EnableDialog({ email, onClose, onDone }: { email: string | null; onClose: () => void; onDone: (s: TwoFactorStatus) => void }) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [startError, setStartError] = useState<{ code: string; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ codes: string[]; status: TwoFactorStatus } | null>(null);
  const [pending, start] = useTransition();
  const [copied, copy] = useCopy();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStartError(null);
    void startTwoFactor().then((res) => {
      if (!live) return;
      if (res.ok) setEnrollment({ secret: res.secret, otpauthUri: res.otpauthUri });
      else setStartError({ code: res.code, text: res.error });
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const verify = (value: string) => {
    if (pending || value.length !== 6) return;
    start(async () => {
      const res = await confirmTwoFactor(value);
      if (res.ok) {
        setResult({ codes: res.backupCodes, status: res.status });
        return;
      }
      setError(res.error);
      setCode("");
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    verify(code);
  };

  const signInAgain = async () => {
    await signOut();
    router.replace(`/sign-in?${new URLSearchParams({ next: SECURITY_PATH })}`);
  };

  if (result) {
    return (
      <Dialog title="Save your backup codes" onClose={onClose} locked>
        <BackupCodesStep
          codes={result.codes}
          email={email}
          lead="Two-factor authentication is on. If you lose your device, sign in with one of these codes instead."
          onDone={() => onDone(result.status)}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title="Turn on two-factor authentication" onClose={onClose}>
      {startError ? (
        <>
          <div className="tf-dialog__body">
            <p className="tf-lead" role="alert">
              {startError.text}
            </p>
          </div>
          <div className="tf-dialog__foot">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose}>
              Cancel
            </button>
            {startError.code === "reauth_required" ? (
              <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={signInAgain}>
                Sign in again
              </button>
            ) : (
              <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
          </div>
        </>
      ) : !enrollment ? (
        <div className="tf-dialog__body tf-loading" aria-busy="true">
          <span className="tf-spin" aria-hidden="true" />
          Preparing your QR code…
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="tf-dialog__body">
            <ol className="tf-steps">
              <li>
                <b>Scan this QR code</b> with your authenticator app.
                <div className="tf-enroll">
                  <QrCode uri={enrollment.otpauthUri} />
                  <div className="tf-secret">
                    <span className="ob-l" id="tf-secret-l">
                      Can’t scan it? Enter this key
                    </span>
                    <code aria-labelledby="tf-secret-l" data-testid="tf-secret">
                      {groupSecret(enrollment.secret)}
                    </code>
                    <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => copy("secret", enrollment.secret)}>
                      {copied === "secret" ? "Copied" : copied === "secret:failed" ? "Couldn’t copy" : "Copy key"}
                    </button>
                  </div>
                </div>
              </li>
              <li>
                <b>Enter the 6-digit code</b> the app shows.
                <CodeField
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    setError(null);
                  }}
                  onComplete={verify}
                  invalid={error !== null}
                  disabled={pending}
                  describedBy={error ? "tf-enable-err" : undefined}
                />
                <ErrorLine id="tf-enable-err" text={error} />
              </li>
            </ol>
          </div>
          <div className="tf-dialog__foot">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={code.length !== 6 || pending}>
              Turn on
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Turn off

function DisableDialog({ onClose, onDone }: { onClose: () => void; onDone: (s: TwoFactorStatus) => void }) {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const backupInput = useRef<HTMLInputElement>(null);
  const ready = backup ? isBackupCode(backupCode) : code.length === 6;

  const send = (proof: { code: string } | { backup_code: string }) => {
    if (pending) return;
    start(async () => {
      const res = await disableTwoFactor(proof);
      if (res.ok) {
        onDone(res.status);
        return;
      }
      setError(res.error);
      if ("code" in proof) setCode("");
      else backupInput.current?.select();
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    send(backup ? { backup_code: backupCode } : { code });
  };

  const toggle = () => {
    setBackup(!backup);
    setError(null);
    if (!backup) requestAnimationFrame(() => backupInput.current?.focus());
  };

  return (
    <Dialog title="Turn off two-factor authentication" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="tf-dialog__body">
          <p className="tf-lead">
            Signing in will only need your email or passkey again. Your backup codes stop working.{" "}
            {backup ? "Enter one of your backup codes to confirm." : "Enter the current code from your authenticator app to confirm."}
          </p>
          {backup ? (
            <div className="ob-f">
              <label className="ob-l" htmlFor="tf-disable-backup">
                Backup code
              </label>
              <div className={`ob-in${error ? " bad" : ""}`}>
                <ObIcon name="lock" />
                <input
                  ref={backupInput}
                  id="tf-disable-backup"
                  value={backupCode}
                  onChange={(e) => {
                    setBackupCode(cleanBackupCode(e.target.value));
                    setError(null);
                  }}
                  placeholder="xxxx-xxxx"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={9}
                  disabled={pending}
                  aria-invalid={error !== null || undefined}
                  aria-describedby={error ? "tf-disable-err" : undefined}
                />
              </div>
            </div>
          ) : (
            <CodeField
              value={code}
              onChange={(v) => {
                setCode(v);
                setError(null);
              }}
              onComplete={(v) => send({ code: v })}
              invalid={error !== null}
              disabled={pending}
              describedBy={error ? "tf-disable-err" : undefined}
            />
          )}
          <ErrorLine id="tf-disable-err" text={error} />
          <button type="button" className="tf-switch cp-link" onClick={toggle}>
            {backup ? "Use your authenticator app" : "Use a backup code"}
          </button>
        </div>
        <div className="tf-dialog__foot">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--sm tf-btn-danger${pending ? " is-loading" : ""}`} disabled={!ready || pending}>
            Turn off
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Regenerate backup codes

function RegenerateDialog({ email, onClose, onDone }: { email: string | null; onClose: () => void; onDone: (s: TwoFactorStatus) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ codes: string[]; status: TwoFactorStatus } | null>(null);
  const [pending, start] = useTransition();

  const send = (value: string) => {
    if (pending || value.length !== 6) return;
    start(async () => {
      const res = await regenerateBackupCodes(value);
      if (res.ok) {
        setResult({ codes: res.backupCodes, status: res.status });
        return;
      }
      setError(res.error);
      setCode("");
    });
  };

  if (result) {
    return (
      <Dialog title="Save your new backup codes" onClose={onClose} locked>
        <BackupCodesStep
          codes={result.codes}
          email={email}
          lead="Your old backup codes no longer work. Keep these somewhere safe instead."
          onDone={() => onDone(result.status)}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title="Regenerate backup codes" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(code);
        }}
        noValidate
      >
        <div className="tf-dialog__body">
          <p className="tf-lead">
            You’ll get ten new backup codes and every old one stops working, used or not. Enter the current code from your authenticator app to continue.
          </p>
          <CodeField
            value={code}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
            onComplete={send}
            invalid={error !== null}
            disabled={pending}
            describedBy={error ? "tf-regen-err" : undefined}
          />
          <ErrorLine id="tf-regen-err" text={error} />
        </div>
        <div className="tf-dialog__foot">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={code.length !== 6 || pending}>
            Regenerate
          </button>
        </div>
      </form>
    </Dialog>
  );
}
