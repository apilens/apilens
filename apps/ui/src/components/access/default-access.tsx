"use client";

// The project's default access on Access › Members (#808, #753 D2): what organization members
// get here without being added. Under the people table it is one line with "Change" (#999); Change
// opens the three choices with a sentence each. A narrower choice
// first asks the API for a dry run and confirms in the shared dialog with how many people lose
// access (the dry run's count) and who drops to a lower role, naming up to five. A wider choice
// is saved directly, and the line comes back. Changing it needs `access.manage` and a recent
// sign-in (D12); everyone else sees the line with the reason and no Change. Styled by default-access.css.
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { previewDefaultAccess, setDefaultAccess } from "@/app/[project]/access/default-access-actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useReauth } from "@/components/reauth-dialog";
import { defaultAccessText } from "@/lib/access-members";
import {
  type AccessImpact,
  CHOICE_HELP,
  DEFAULT_ACCESS_CHOICES,
  SAVED_TEXT,
  accessImpact,
  choiceTitle,
  dropLine,
  isNarrower,
  loseLine,
  namesLine,
} from "@/lib/default-access";
import type { AccessMember, DefaultAccess } from "@/lib/identity";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import { useCan } from "@/lib/permissions";
import "../org-settings/org-settings.css";
import "./default-access.css";

type Confirm = { to: DefaultAccess; lose: number; impact: AccessImpact };
type Status = { tone: "ok" | "err" | ""; text: string };

export function DefaultAccessCard({
  project,
  projectName,
  orgName,
  defaultAccess,
  members,
}: {
  project: string;
  projectName: string;
  orgName: string;
  defaultAccess: DefaultAccess;
  members: AccessMember[];
}) {
  const router = useRouter();
  const can = useCan("access.manage");
  const id = useId();
  const [current, setCurrent] = useState(defaultAccess);
  const [selected, setSelected] = useState(defaultAccess);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ tone: "", text: "" });
  const [editing, setEditing] = useState(false);
  const { withReauth, dialog: reauthDialog } = useReauth();
  const headId = `${id}-h`;
  const reasonId = `${id}-why`;
  const changeRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Focus follows the toggle: into the checked choice on Change, back to Change when it closes.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    if (editing) formRef.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
    else changeRef.current?.focus();
  }, [editing]);
  const toggle = (open: boolean) => {
    moved.current = true;
    setEditing(open);
  };

  const apply = async (to: DefaultAccess) => {
    const result = await withReauth(() => setDefaultAccess(project, to));
    if (result.ok) {
      setCurrent(to);
      setSelected(to);
      setConfirm(null);
      setStatus({ tone: "ok", text: SAVED_TEXT[to] });
      toggle(false);
      router.refresh();
      return;
    }
    if (result.code === REAUTH_CANCELLED) {
      if (confirm) setConfirmError(result.error);
      else setStatus({ tone: "", text: result.error });
      return;
    }
    if (confirm) setConfirmError(result.error);
    else setStatus({ tone: "err", text: result.error });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending || !can.allowed || selected === current) return;
    setPending(true);
    setStatus({ tone: "", text: "" });
    try {
      if (!isNarrower(current, selected)) {
        await apply(selected);
        return;
      }
      const dry = await withReauth(() => previewDefaultAccess(project, selected));
      if (!dry.ok) {
        setStatus({ tone: dry.code === REAUTH_CANCELLED ? "" : "err", text: dry.error });
        return;
      }
      setConfirmError(null);
      setConfirm({ to: selected, lose: dry.change.lose_access, impact: accessImpact(members, selected) });
    } finally {
      setPending(false);
    }
  };

  const confirmChange = async () => {
    if (!confirm || pending) return;
    setPending(true);
    setConfirmError(null);
    try {
      await apply(confirm.to);
    } finally {
      setPending(false);
    }
  };

  const cancel = () => {
    setConfirm(null);
    setConfirmError(null);
    setSelected(current);
    setStatus({ tone: "", text: "Cancelled. The default access is unchanged." });
  };

  const close = () => {
    setSelected(current);
    setStatus({ tone: "", text: "" });
    toggle(false);
  };

  const statusLine = (
    <p className={`os-status da-status${status.tone ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
      {status.text}
    </p>
  );

  return (
    <section className={`os-card da${editing ? " is-open" : ""}`} aria-labelledby={headId}>
      {editing ? (
        <form ref={formRef} onSubmit={submit} noValidate>
          <div className="os-card__head">
            <h2 id={headId}>Default access</h2>
            <p>What people in {orgName} get on {projectName} without being added here.</p>
          </div>
          <div className="os-card__body">
            <fieldset className="da-choices" disabled={pending}>
              <legend className="sr-only">Default access for {projectName}</legend>
              {DEFAULT_ACCESS_CHOICES.map((def) => (
                <label key={def} className={`da-choice${selected === def ? " on" : ""}`}>
                  <input
                    type="radio"
                    name={`${id}-def`}
                    value={def}
                    checked={selected === def}
                    aria-describedby={`${id}-${def}-help`}
                    onChange={() => {
                      setSelected(def);
                      setStatus({ tone: "", text: "" });
                    }}
                  />
                  <span>
                    <b>
                      {choiceTitle(def, orgName)}
                      {current === def ? <span className="da-current">Current</span> : null}
                    </b>
                    <span id={`${id}-${def}-help`}>{CHOICE_HELP[def]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="os-card__foot">
            {statusLine}
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending && !confirm ? " is-loading" : ""}`} disabled={pending || selected === current}>
              Save default access
            </button>
          </div>
        </form>
      ) : (
        <div className="da-line">
          <h2 id={headId} className="sr-only">
            Default access
          </h2>
          <div className="da-line__t">
            <p className="da-line__text">{defaultAccessText(current)}</p>
            {can.allowed ? (
              statusLine
            ) : (
              <p id={reasonId} className="da-line__why">
                Only project admins can change the default access.
              </p>
            )}
          </div>
          {can.allowed ? (
            <button ref={changeRef} type="button" className="ah-btn ah-btn--secondary ah-btn--sm" aria-label="Change default access" onClick={() => toggle(true)}>
              Change
            </button>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.to === "none" ? `Restrict ${projectName}?` : `Change the default access of ${projectName}?`}
        actionLabel={confirm?.to === "none" ? "Restrict project" : "Change default access"}
        pending={pending}
        error={confirmError}
        onConfirm={confirmChange}
        onCancel={cancel}
      >
        {confirm ? <ImpactText confirm={confirm} projectName={projectName} /> : null}
      </ConfirmDialog>
      {reauthDialog}
    </section>
  );
}

/** What the change does, in the dialog: who loses access (the dry run's count) and who drops a role. */
function ImpactText({ confirm, projectName }: { confirm: Confirm; projectName: string }) {
  const { lose, impact } = confirm;
  const dropped = impact.drop;
  const losing = namesLine(impact.lose.map((a) => a.member), lose);
  return (
    <>
      {lose > 0 ? (
        <p className="da-impact" data-impact="lose">
          {losing ? (
            <>
              <b>{loseLine(lose, projectName)}:</b> {losing}.
            </>
          ) : (
            <b>{loseLine(lose, projectName)}.</b>
          )}
        </p>
      ) : null}
      {dropped.length > 0 ? (
        <p className="da-impact" data-impact="drop">
          <b>{dropLine(dropped)}:</b> {namesLine(dropped.map((a) => a.member))}.
        </p>
      ) : null}
      {lose === 0 && dropped.length === 0 ? <p>Nobody loses access or drops to a lower role.</p> : null}
      <p>Organization owners and admins, and people added to {projectName}, keep their access.</p>
    </>
  );
}

/** The label next to the project's name on this page when it is restricted (default access none). */
export function RestrictedLabel({ defaultAccess }: { defaultAccess: DefaultAccess | null }) {
  return defaultAccess === "none" ? <span className="da-restricted">Restricted</span> : null;
}
