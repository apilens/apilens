"use client";

import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState, useTransition } from "react";
import { type OrgActionResult, deleteOrganization, saveOrgDomains, saveOrgName } from "@/app/orgs/[org]/settings/actions";
import type { Org } from "@/lib/identity";
import { addDomains, canDeleteOrg, canManageOrg, checkOrgName, deleteConfirmed, MAX_ORG_NAME } from "@/lib/org-settings";
import { roleLabel } from "@/lib/scope";
import { ConfirmDialog } from "../confirm-dialog";
import { ObIcon } from "../onboarding/ob";
import { OrgSettingsNav } from "./nav";
import "./org-settings.css";

type Status = { tone: "ok" | "err"; text: string } | null;

function statusOf(result: OrgActionResult, saved: string): Status {
  return result.ok ? { tone: "ok", text: saved } : { tone: "err", text: result.error };
}

function StatusLine({ status, id }: { status: Status; id: string }) {
  return (
    <span id={id} className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
      {status?.text ?? ""}
    </span>
  );
}

/**
 * `/orgs/<org>/settings` (#347): the organization's name, its address (slug, read-only), the
 * email domains whose people may join automatically, and deleting it. Owners and admins edit;
 * members and viewers see the same values read-only. Only owners see the delete button.
 */
export function OrgGeneralSettings({ org, deletedProject = null }: { org: Org; deletedProject?: string | null }) {
  const manage = canManageOrg(org.role);
  return (
    <div className="page page--measure os">
      <header className="os-head">
        <p className="cp-h">Organization</p>
        <h1 className="cp-lede">Settings</h1>
        <OrgSettingsNav org={org.slug} current="" role={org.role} />
      </header>

      {deletedProject ? (
        <p className="os-note" role="status">
          <ObIcon name="done" />
          <span>Project {deletedProject} was deleted. Its data is removed after 7 days; until then an organization admin can restore it.</span>
        </p>
      ) : null}

      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>
            You’re a {roleLabel(org.role).toLowerCase()} of {org.name}. Only owners and admins can change these settings.
          </span>
        </p>
      )}

      <GeneralCard org={org} manage={manage} />
      <DomainsCard org={org} manage={manage} />
      {canDeleteOrg(org.role) ? <DangerCard org={org} /> : null}
    </div>
  );
}

function GeneralCard({ org, manage }: { org: Org; manage: boolean }) {
  const [saved, setSaved] = useState(org.name);
  const [name, setName] = useState(org.name);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const checked = checkOrgName(name);
  const dirty = name.trim() !== saved;
  const invalid = dirty && !checked.ok;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage || !dirty || !checked.ok || pending) return;
    start(async () => {
      const result = await saveOrgName(org.slug, checked.name);
      setStatus(statusOf(result, "Name saved."));
      if (result.ok) {
        setSaved(result.org.name);
        setName(result.org.name);
      }
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(org.slug);
      setCopied(true);
    } catch {
      setStatus({ tone: "err", text: "Couldn’t copy. Select the address and copy it instead." });
    }
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="os-general">
      <div className="os-card__head">
        <h2 id="os-general">General</h2>
        <p>How the organization appears to its members and in links.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <label className="ob-l" htmlFor="os-name">
            Name
          </label>
          <div className={`ob-in${invalid ? " bad" : ""}${manage ? "" : " ro"}`}>
            <ObIcon name="building" />
            <input
              id="os-name"
              name="name"
              autoComplete="organization"
              maxLength={MAX_ORG_NAME + 20}
              value={name}
              disabled={!manage}
              onChange={(e) => {
                setName(e.target.value);
                setStatus(null);
              }}
              aria-invalid={invalid}
              aria-describedby={invalid ? "os-name-err" : undefined}
            />
          </div>
          {invalid && !checked.ok ? (
            <p id="os-name-err" className="ob-err">
              {checked.error}
            </p>
          ) : null}
        </div>
        <div className="ob-f">
          <span className="ob-l" id="os-slug-l">
            Address<small>used in links and the CLI · can’t be changed yet</small>
          </span>
          <div className="ob-in ro" aria-labelledby="os-slug-l">
            <ObIcon name="link" />
            <span className="val">{org.slug}</span>
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm os-copy" onClick={copy} aria-label={`Copy address ${org.slug}`}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
      {manage ? (
        <div className="os-card__foot">
          <StatusLine status={status} id="os-general-status" />
          {dirty ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setName(saved)} disabled={pending}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || !checked.ok || pending}>
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

function DomainsCard({ org, manage }: { org: Org; manage: boolean }) {
  const initial = { domains: org.allowed_domains ?? [], join: org.domain_join ?? false };
  const [saved, setSaved] = useState(initial);
  const [domains, setDomains] = useState(initial.domains);
  const [join, setJoin] = useState(initial.join);
  const [draft, setDraft] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [serverCode, setServerCode] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const effectiveJoin = join && domains.length > 0;
  const dirty = domains.join(" ") !== saved.domains.join(" ") || effectiveJoin !== saved.join;
  const bad = entryError !== null || serverCode === "domain_not_allowed";

  const edited = () => {
    setStatus(null);
    setServerCode(null);
  };

  /** Turns the entry into chips; false when it holds something that is not a domain. */
  const commit = (text: string): boolean => {
    if (!text.trim()) return true;
    const result = addDomains(domains, text);
    setEntryError(result.error);
    if (result.error) return false;
    setDomains(result.domains);
    setDraft("");
    edited();
    return true;
  };

  const remove = (domain: string) => {
    setDomains((list) => list.filter((d) => d !== domain));
    edited();
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && domains.length > 0) {
      e.preventDefault();
      remove(domains[domains.length - 1]);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage || pending) return;
    // A domain still being typed counts, as if Enter had been pressed.
    if (draft.trim() && !commit(draft)) return;
    const list = draft.trim() ? addDomains(domains, draft).domains : domains;
    const nextJoin = join && list.length > 0;
    if (!draft.trim() && !dirty) return;
    start(async () => {
      const result = await saveOrgDomains(org.slug, list, nextJoin);
      setStatus(statusOf(result, "Domains saved."));
      setServerCode(result.ok ? null : (result.code ?? null));
      if (result.ok) {
        const next = { domains: result.org.allowed_domains ?? [], join: result.org.domain_join ?? false };
        setSaved(next);
        setDomains(next.domains);
        setJoin(next.join);
      }
    });
  };

  const reset = () => {
    setDomains(saved.domains);
    setJoin(saved.join);
    setDraft("");
    setEntryError(null);
    edited();
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="os-domains">
      <div className="os-card__head">
        <h2 id="os-domains">Email domains</h2>
        <p>People who sign up with a verified email at these domains can find {org.name}.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <label className="ob-l" htmlFor="os-domain-entry">
            Allowed email domains<small>{domains.length ? `${domains.length} listed` : "none yet"}</small>
          </label>
          {/* Clicking anywhere in the field focuses the entry; chips and their buttons stay keyboard reachable. */}
          <div className={`os-chips${bad ? " bad" : ""}${manage ? "" : " ro"}`} onClick={() => input.current?.focus()}>
            {domains.map((d) => (
              <span key={d} className="os-chip">
                {d}
                {manage ? (
                  <button type="button" aria-label={`Remove ${d}`} onClick={(e) => { e.stopPropagation(); remove(d); }}>
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            {manage ? (
              <input
                ref={input}
                id="os-domain-entry"
                value={draft}
                placeholder={domains.length ? "Add another" : "acme.com"}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setEntryError(null);
                }}
                onKeyDown={onKey}
                onPaste={onPaste}
                onBlur={() => commit(draft)}
                aria-invalid={bad}
                aria-describedby={entryError ? "os-domain-err" : "os-domain-help"}
              />
            ) : domains.length === 0 ? (
              <span className="os-empty">No domains</span>
            ) : null}
          </div>
          {entryError ? (
            <p id="os-domain-err" className="ob-err">
              {entryError}
            </p>
          ) : !manage ? null : (
            <p id="os-domain-help" className="os-help">
              Press Enter or comma after each domain. Public email providers like gmail.com aren’t allowed.
            </p>
          )}
        </div>

        <button
          type="button"
          className="os-toggle"
          role="switch"
          aria-checked={effectiveJoin}
          disabled={!manage || domains.length === 0}
          onClick={() => {
            setJoin(!effectiveJoin);
            edited();
          }}
        >
          <span className="t">
            <b>Let people with these domains join automatically</b>
            <span>
              {domains.length === 0
                ? "Add a domain first. Until then, people join by invitation only."
                : `Anyone with a verified email at ${domains.length === 1 ? domains[0] : "one of these domains"} joins as a member, without an invitation.`}
            </span>
          </span>
          <span className={`ob-sw${effectiveJoin ? " on" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {manage ? (
        <div className="os-card__foot">
          <StatusLine status={status} id="os-domains-status" />
          {dirty || draft ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={reset} disabled={pending}>
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`}
            disabled={(!dirty && !draft.trim()) || entryError !== null || pending}
          >
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

function DangerCard({ org }: { org: Org }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = (typed: string) => {
    if (!deleteConfirmed(org.slug, typed) || pending) return;
    setError(null);
    start(async () => {
      // Redirects away on success; answers only when the deletion failed.
      const result = await deleteOrganization(org.slug, typed);
      if (result && !result.ok) setError(result.error);
    });
  };

  const close = () => {
    setOpen(false);
    setError(null);
  };

  return (
    <section className="os-card os-card--danger" aria-labelledby="os-danger">
      <div className="os-card__head">
        <h2 id="os-danger">Danger zone</h2>
      </div>
      <div className="os-card__body">
        <div className="os-danger">
          <p className="t">
            <b>Delete this organization</b>
            Its projects, API keys and data stop being available to every member, and the address {org.slug} becomes free.
          </p>
          <button type="button" className="ah-btn ah-btn--sm os-btn-outline-danger" onClick={() => setOpen(true)}>
            Delete organization
          </button>
        </div>
        <ConfirmDialog
          open={open}
          title={`Delete ${org.name}?`}
          phrase={org.slug}
          actionLabel={`Delete ${org.name}`}
          pending={pending}
          error={error}
          onConfirm={confirm}
          onCancel={close}
        >
          <p>
            Its projects, API keys and data stop being available to every member, and the address {org.slug} becomes free.
          </p>
        </ConfirmDialog>
      </div>
    </section>
  );
}
