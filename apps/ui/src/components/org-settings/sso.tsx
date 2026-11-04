"use client";

import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState, useTransition } from "react";
import { deleteSSOConnection, saveSSOConnection, testSSOConnection } from "@/app/orgs/[org]/settings/sso/actions";
import type { OrgRole, SSOConnection, SSOTestResult } from "@/lib/identity";
import { formatJoined } from "@/lib/org-members";
import { addDomains } from "@/lib/org-settings";
import {
  MAX_SSO_CLIENT_ID,
  MAX_SSO_CLIENT_SECRET,
  MAX_SSO_ISSUER,
  SSO_DEFAULT_ROLES,
  type SSOField,
  canManageSSO,
  checkSSOForm,
  discoveredEndpoints,
  enforceState,
  ssoTestError,
} from "@/lib/org-sso";
import { roleLabel } from "@/lib/scope";
import { ssoStartHref } from "@/lib/sso";
import { ObIcon } from "../onboarding/ob";
import { type OrgRef as BaseOrgRef, type Status } from "./controls";
import { OrgSettingsNav } from "./nav";
import "./org-settings.css";
import "./sso.css";

type OrgRef = BaseOrgRef & { role: OrgRole };

function StatusLine({ status, id }: { status: Status; id: string }) {
  return (
    <span id={id} className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
      {status?.text ?? ""}
    </span>
  );
}

function useCopied(): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      return true;
    } catch {
      return false;
    }
  };
  return [copied, copy];
}

/**
 * `/orgs/<org>/settings/sso` (#348): the organization's OpenID Connect connection (issuer,
 * client, email domains, the role new people get), a discovery test, requiring SSO for the
 * domains, and removing the connection. Owners only; anyone else sees why.
 */
export function OrgSSOSettings({ org, connection }: { org: OrgRef; connection: SSOConnection | null }) {
  const owner = canManageSSO(org.role);
  const [conn, setConn] = useState(connection);
  return (
    <div className="os">
      <header className="os-head">
        <p className="cp-h">Organization</p>
        <h1 className="cp-lede">Settings</h1>
        <OrgSettingsNav org={org.slug} current="sso" />
      </header>

      {owner ? (
        <>
          <ConnectionCard org={org} conn={conn} onSaved={setConn} />
          <EnforceCard org={org} conn={conn} onSaved={setConn} />
          <p className="os-note sso-audit">
            <ObIcon name="info" />
            <span>Every change to single sign-on, including removing it, is recorded in the organization’s audit log with who made it.</span>
          </p>
          {conn ? <RemoveCard org={org} onRemoved={() => setConn(null)} /> : null}
        </>
      ) : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>
            You’re {org.role === "admin" ? "an" : "a"} {roleLabel(org.role).toLowerCase()} of {org.name}. Only owners can set up or change single sign-on, because it decides how
            everyone at your email domains signs in.
          </span>
        </p>
      )}
    </div>
  );
}

function ConnectionCard({ org, conn, onSaved }: { org: OrgRef; conn: SSOConnection | null; onSaved: (c: SSOConnection) => void }) {
  const initial = {
    issuer: conn?.issuer ?? "",
    clientId: conn?.client_id ?? "",
    domains: conn?.domains ?? [],
    defaultRole: (conn?.default_role ?? "member") as string,
  };
  const [issuer, setIssuer] = useState(initial.issuer);
  const [clientId, setClientId] = useState(initial.clientId);
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState<string[]>(initial.domains);
  const [draft, setDraft] = useState("");
  const [defaultRole, setDefaultRole] = useState(initial.defaultRole);
  const [fieldError, setFieldError] = useState<{ field: SSOField; error: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [test, setTest] = useState<{ result: SSOTestResult } | { error: string } | null>(null);
  const [copied, copy] = useCopied();
  const domainInput = useRef<HTMLInputElement>(null);

  const dirty =
    issuer.trim() !== initial.issuer ||
    clientId.trim() !== initial.clientId ||
    secret !== "" ||
    domains.join(" ") !== initial.domains.join(" ") ||
    draft.trim() !== "" ||
    defaultRole !== initial.defaultRole;

  const edited = (field?: SSOField) => {
    setStatus(null);
    if (!field || fieldError?.field === field) setFieldError(null);
  };
  const errorFor = (field: SSOField) => (fieldError?.field === field ? fieldError.error : null);

  const commitDomains = (text: string): boolean => {
    if (!text.trim()) return true;
    const result = addDomains(domains, text);
    if (result.error) {
      setFieldError({ field: "domains", error: result.error });
      return false;
    }
    setDomains(result.domains);
    setDraft("");
    edited("domains");
    return true;
  };

  const removeDomain = (domain: string) => {
    setDomains((list) => list.filter((d) => d !== domain));
    edited("domains");
    domainInput.current?.focus();
  };

  const onDomainKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
      e.preventDefault();
      commitDomains(draft);
    } else if (e.key === "Backspace" && draft === "" && domains.length > 0) {
      e.preventDefault();
      removeDomain(domains[domains.length - 1]);
    }
  };

  const onDomainPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    commitDomains(`${draft} ${text}`);
  };

  const reset = () => {
    setIssuer(initial.issuer);
    setClientId(initial.clientId);
    setSecret("");
    setDomains(initial.domains);
    setDraft("");
    setDefaultRole(initial.defaultRole);
    setFieldError(null);
    setStatus(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !dirty) return;
    // A domain still being typed counts, as if Enter had been pressed.
    if (draft.trim() && !commitDomains(draft)) return;
    const list = draft.trim() ? addDomains(domains, draft).domains : domains;
    const form = { issuer, clientId, clientSecret: secret, domains: list, defaultRole, enforce: conn?.enforce ?? false };
    const checked = checkSSOForm(form, conn !== null);
    if (!checked.ok) {
      setFieldError({ field: checked.field, error: checked.error });
      return;
    }
    start(async () => {
      const result = await saveSSOConnection(org.slug, form, conn !== null);
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        if (result.code === "domain_not_allowed" || result.code === "sso_domain_taken") setFieldError({ field: "domains", error: result.error });
        return;
      }
      setStatus({ tone: "ok", text: conn ? "Connection saved." : "Connection saved. Now sign in through it once to test it." });
      setSecret("");
      setDomains(result.connection.domains ?? []);
      setIssuer(result.connection.issuer);
      setClientId(result.connection.client_id);
      setDefaultRole(result.connection.default_role);
      onSaved(result.connection);
    });
  };

  const runTest = () => {
    if (testing) return;
    setTest(null);
    startTest(async () => {
      const result = await testSSOConnection(org.slug, issuer.trim());
      if (!result.ok) {
        if (result.code === "invalid_request") setFieldError({ field: "issuer", error: result.error });
        setTest({ error: result.error });
        return;
      }
      setTest({ result: result.result });
    });
  };

  const copyRedirect = async () => {
    if (!conn) return;
    if (!(await copy(conn.redirect_uri))) setStatus({ tone: "err", text: "Couldn’t copy. Select the redirect URI and copy it instead." });
  };

  const issuerErr = errorFor("issuer");
  const clientIdErr = errorFor("clientId");
  const secretErr = errorFor("clientSecret");
  const domainsErr = errorFor("domains");
  const canTest = issuer.trim() !== "" || conn !== null;

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="sso-conn" noValidate>
      <div className="os-card__head sso-head">
        <div>
          <h2 id="sso-conn">OpenID Connect</h2>
          <p>Let people at your email domains sign in with your identity provider, such as Okta, Microsoft Entra ID or Google Workspace.</p>
        </div>
        <ConnectionBadge conn={conn} />
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <span className="ob-l" id="sso-redirect-l">
            Redirect URI<small>register it with your identity provider</small>
          </span>
          <div className="ob-in ro" aria-labelledby="sso-redirect-l">
            <ObIcon name="link" />
            {conn ? (
              <>
                <span className="val">{conn.redirect_uri}</span>
                <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm os-copy" onClick={copyRedirect} aria-label="Copy redirect URI">
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            ) : (
              <span className="val sso-muted">Shown once the connection is saved</span>
            )}
          </div>
        </div>

        <div className="ob-f">
          <label className="ob-l" htmlFor="sso-issuer">
            Issuer URL<small>https only</small>
          </label>
          <div className="sso-row">
            <div className={`ob-in${issuerErr ? " bad" : ""}`}>
              <ObIcon name="out" />
              <input
                id="sso-issuer"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://login.example.com"
                maxLength={MAX_SSO_ISSUER}
                value={issuer}
                onChange={(e) => {
                  setIssuer(e.target.value);
                  setTest(null);
                  edited("issuer");
                }}
                aria-invalid={issuerErr !== null}
                aria-describedby={issuerErr ? "sso-issuer-err" : undefined}
              />
            </div>
            <button
              type="button"
              className={`ah-btn ah-btn--secondary ah-btn--sm sso-test-btn${testing ? " is-loading" : ""}`}
              onClick={runTest}
              disabled={!canTest || testing}
              aria-describedby="sso-test-out"
            >
              Test connection
            </button>
          </div>
          {issuerErr ? (
            <p id="sso-issuer-err" className="ob-err">
              {issuerErr}
            </p>
          ) : (
            <p className="os-help">Exactly as your provider states it. The test reads its /.well-known/openid-configuration.</p>
          )}
          <div id="sso-test-out" aria-live="polite">
            {test ? <TestOutcome test={test} /> : null}
          </div>
        </div>

        <div className="ob-f">
          <label className="ob-l" htmlFor="sso-client-id">
            Client ID
          </label>
          <div className={`ob-in${clientIdErr ? " bad" : ""}`}>
            <ObIcon name="code" />
            <input
              id="sso-client-id"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={MAX_SSO_CLIENT_ID}
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                edited("clientId");
              }}
              aria-invalid={clientIdErr !== null}
              aria-describedby={clientIdErr ? "sso-client-id-err" : undefined}
            />
          </div>
          {clientIdErr ? (
            <p id="sso-client-id-err" className="ob-err">
              {clientIdErr}
            </p>
          ) : null}
        </div>

        <div className="ob-f">
          <label className="ob-l" htmlFor="sso-secret">
            Client secret<small>{conn ? "stored encrypted · leave empty to keep it" : "stored encrypted"}</small>
          </label>
          <div className={`ob-in${secretErr ? " bad" : ""}`}>
            <ObIcon name="lock" />
            <input
              id="sso-secret"
              type="password"
              autoComplete="new-password"
              maxLength={MAX_SSO_CLIENT_SECRET}
              placeholder={conn ? "•••••••• (unchanged)" : ""}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                edited("clientSecret");
              }}
              aria-invalid={secretErr !== null}
              aria-describedby={secretErr ? "sso-secret-err" : "sso-secret-help"}
            />
          </div>
          {secretErr ? (
            <p id="sso-secret-err" className="ob-err">
              {secretErr}
            </p>
          ) : (
            <p id="sso-secret-help" className="os-help">
              Write-only: once saved, nobody can read it back, not even owners.
            </p>
          )}
        </div>

        <div className="ob-f">
          <label className="ob-l" htmlFor="sso-domain-entry">
            Email domains<small>{domains.length ? `${domains.length} listed` : "at least one"}</small>
          </label>
          <div className={`os-chips${domainsErr ? " bad" : ""}`} onClick={() => domainInput.current?.focus()}>
            {domains.map((d) => (
              <span key={d} className="os-chip">
                {d}
                <button
                  type="button"
                  aria-label={`Remove ${d}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDomain(d);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={domainInput}
              id="sso-domain-entry"
              value={draft}
              placeholder={domains.length ? "Add another" : "acme.com"}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              onChange={(e) => {
                setDraft(e.target.value);
                edited("domains");
              }}
              onKeyDown={onDomainKey}
              onPaste={onDomainPaste}
              onBlur={() => commitDomains(draft)}
              aria-invalid={domainsErr !== null}
              aria-describedby={domainsErr ? "sso-domain-err" : "sso-domain-help"}
            />
          </div>
          {domainsErr ? (
            <p id="sso-domain-err" className="ob-err">
              {domainsErr}
            </p>
          ) : (
            <p id="sso-domain-help" className="os-help">
              People who sign in with an email at these domains are offered your SSO. Public providers like gmail.com aren’t allowed.
            </p>
          )}
        </div>

        <div className="ob-f">
          <label className="ob-l" htmlFor="sso-role">
            Default role<small>for first SSO sign-ins</small>
          </label>
          <select
            id="sso-role"
            className="sso-select"
            value={defaultRole}
            onChange={(e) => {
              setDefaultRole(e.target.value);
              edited("defaultRole");
            }}
          >
            {SSO_DEFAULT_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="os-card__foot">
        <StatusLine status={status} id="sso-conn-status" />
        {dirty ? (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={reset} disabled={pending}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || pending}>
          {conn ? "Save" : "Save connection"}
        </button>
      </div>
    </form>
  );
}

function ConnectionBadge({ conn }: { conn: SSOConnection | null }) {
  if (!conn) return <span className="sso-badge">Not set up</span>;
  if (conn.enforce) return <span className="sso-badge on">Required</span>;
  if (conn.last_login_at) return <span className="sso-badge ok">Active · last sign-in {formatJoined(conn.last_login_at)}</span>;
  return <span className="sso-badge warn">Untested</span>;
}

function TestOutcome({ test }: { test: { result: SSOTestResult } | { error: string } }) {
  if ("error" in test) {
    return (
      <div className="sso-test bad" role="alert">
        <b>Couldn’t test the connection</b>
        <span>{test.error}</span>
      </div>
    );
  }
  const { result } = test;
  if (!result.ok) {
    return (
      <div className="sso-test bad" role="alert">
        <b>Discovery failed for {result.issuer}</b>
        <span>{ssoTestError(result)}</span>
      </div>
    );
  }
  const rows = discoveredEndpoints(result);
  const algs = result.id_token_signing_alg_values_supported ?? [];
  return (
    <div className="sso-test ok">
      <b>
        <ObIcon name="done" />
        Discovery succeeded for {result.issuer}
      </b>
      <dl>
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
        {algs.length ? (
          <div>
            <dt>Signing</dt>
            <dd>{algs.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function EnforceCard({ org, conn, onSaved }: { org: OrgRef; conn: SSOConnection | null; onSaved: (c: SSOConnection) => void }) {
  const [untested, setUntested] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const state = enforceState(conn, untested);
  const on = conn?.enforce ?? false;
  const signIn = conn ? ssoStartHref(conn.start_url, { next: `/orgs/${org.slug}/settings/sso` }) : null;

  const toggle = () => {
    if (!conn || pending || !state.allowed) return;
    const next = !on;
    start(async () => {
      const result = await saveSSOConnection(
        org.slug,
        { issuer: conn.issuer, clientId: conn.client_id, clientSecret: "", domains: conn.domains ?? [], defaultRole: conn.default_role, enforce: next },
        true,
      );
      if (!result.ok) {
        if (result.code === "sso_untested") setUntested(true);
        setStatus({ tone: "err", text: result.error });
        return;
      }
      setStatus({ tone: "ok", text: next ? "SSO is now required." : "SSO is optional again." });
      onSaved(result.connection);
    });
  };

  const domains = conn?.domains ?? [];
  return (
    <section className="os-card" aria-labelledby="sso-enforce">
      <div className="os-card__head">
        <h2 id="sso-enforce">Enforcement</h2>
        <p>Decide whether SSO is an option or the only way in for people at your domains.</p>
      </div>
      <div className="os-card__body">
        <button
          type="button"
          className={`os-toggle${pending ? " is-busy" : ""}`}
          role="switch"
          aria-checked={on}
          disabled={!state.allowed || pending}
          aria-describedby="sso-enforce-why"
          onClick={toggle}
        >
          <span className="t">
            <b>Require SSO for {domains.length === 1 ? domains[0] : "these domains"}</b>
            <span id="sso-enforce-why">
              {!state.allowed
                ? state.reason
                : on
                  ? "People at these domains can only sign in through your identity provider. Email codes, social sign-in and passkeys are refused."
                  : "When on, people at these domains can only sign in through your identity provider."}
            </span>
          </span>
          <span className={`ob-sw${on ? " on" : ""}`} aria-hidden="true" />
        </button>
        {!state.allowed && signIn ? (
          <a className="ah-btn ah-btn--secondary ah-btn--sm sso-signin" href={signIn}>
            <ObIcon name="out" />
            Sign in with SSO to test it
          </a>
        ) : null}
        <p className="sso-enforce-status">
          <StatusLine status={status} id="sso-enforce-status" />
        </p>
      </div>
    </section>
  );
}

function RemoveCard({ org, onRemoved }: { org: OrgRef; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const remove = () => {
    if (pending) return;
    start(async () => {
      const result = await deleteSSOConnection(org.slug);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      onRemoved();
    });
  };

  return (
    <section className="os-card os-card--danger" aria-labelledby="sso-remove">
      <div className="os-card__head">
        <h2 id="sso-remove">Remove connection</h2>
      </div>
      <div className="os-card__body">
        <div className="os-danger">
          <p className="t">
            <b>Remove single sign-on from {org.name}</b>
            Members sign in with email codes, social accounts or passkeys again. You can set it up again later.
          </p>
          {confirming ? (
            <span className="sso-confirm">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => { setConfirming(false); setError(null); }} disabled={pending}>
                Cancel
              </button>
              <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={remove} disabled={pending}>
                Remove
              </button>
            </span>
          ) : (
            <button type="button" className="ah-btn ah-btn--sm os-btn-outline-danger" onClick={() => setConfirming(true)}>
              Remove connection
            </button>
          )}
        </div>
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
