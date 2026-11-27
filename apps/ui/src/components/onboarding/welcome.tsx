"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { type CreateResult, type JoinResult, acceptInvitation, createOrganization, joinOrganization, saveName } from "@/app/(auth)/onboarding/welcome/actions";
import { type SlugStatus, checkableSlug, createSlugChecker, slugify } from "@/lib/org-slug";
import { checkName } from "@/lib/profile";
import { plural, roleLabel } from "@/lib/scope";
import { type WelcomeCard, suggestedOrgName } from "@/lib/welcome";
import { ObIcon, ObShell } from "./ob";
import "./welcome.css";

const FAILED = "Something went wrong. Try again in a moment.";
/** The pick that creates an organization; any other is a card's address. */
const CREATE = "create";

/** What a card's sub-lines say: who invited the user, or how big the organization is. */
function CardLines({ card, domain }: { card: WelcomeCard; domain: string }) {
  if (card.kind === "member") return <small>You’re already a member</small>;
  if (card.kind === "invitation") {
    return (
      <small>
        {card.invitedBy ? `Invited by ${card.invitedBy} · ` : ""}
        {roleLabel(card.role)}
      </small>
    );
  }
  return (
    <>
      <small>
        Your team is already here · {plural(card.memberCount, "member")} · {plural(card.projectCount, "project")}
      </small>
      {domain ? <small>Open to verified @{domain} emails</small> : null}
    </>
  );
}

/**
 * The one onboarding screen: the user's name, then the organization their projects live in — an
 * invitation waiting for their address, an organization their verified email domain may join, one
 * they already belong to, or a new one, which is created with its first project. No step bar and
 * no Back: there is nowhere to go back to. `cards` are the organizations on offer in order
 * (`lib/welcome.ts`), `name` the name to start from, `domain` the user's verified email domain,
 * `host` the public UI host an address is shown under and `owned` the organization addresses the
 * user owns, so their own never reads as taken.
 */
export function Welcome({
  cards,
  name: initialName,
  domain,
  host = "",
  owned = [],
  preferred = "",
}: {
  cards: WelcomeCard[];
  name: string;
  domain: string;
  host?: string;
  owned?: string[];
  /** The organization already chosen (an invitation accepted at its link), picked to start with. */
  preferred?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [picked, setPicked] = useState(cards.find((c) => c.slug === preferred)?.slug ?? cards[0]?.slug ?? CREATE);
  const [typedOrg, setTypedOrg] = useState("");
  const [orgEdited, setOrgEdited] = useState(false);
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  // A card that was stale (accepted or revoked elsewhere) is gone from the reloaded list: fall
  // back to the first one left rather than silently showing the create form instead.
  const chosen = picked === CREATE || cards.some((c) => c.slug === picked) ? picked : (cards[0]?.slug ?? CREATE);
  const card = cards.find((c) => c.slug === chosen);
  const creating = !card;
  // The organization name follows the full name until the user edits it: an email sign-up has no
  // name to prefill from, so what they type here fills it in.
  const orgName = orgEdited ? typedOrg : suggestedOrgName(name);
  const address = edited ? slug : slugify(orgName);
  const mine = owned.includes(address);

  const checker = useRef<ReturnType<typeof createSlugChecker> | null>(null);
  useEffect(() => {
    const c = createSlugChecker({ onResult: (s, status) => setChecked({ slug: s, status }) });
    checker.current = c;
    return () => c.cancel();
  }, []);
  useEffect(() => {
    if (mine || !creating) checker.current?.cancel();
    else checker.current?.check(address);
  }, [address, mine, creating]);

  const status: SlugStatus =
    checked?.slug === address ? checked.status : creating && checkableSlug(address) && !mine ? { kind: "checking" } : { kind: "idle" };
  const taken = status.kind === "taken";
  const named = checkName(name).ok;
  const longEnough = orgName.trim().length > 1;
  const canCreate = longEnough && checkableSlug(address) && (mine || status.kind === "available" || status.kind === "unknown");
  const ready = named && (creating ? canCreate : true);
  // Why Create is off while the fields look fine: no organization name (a name like 张伟 suggests
  // none, since its address would be the possessive alone) or one of a single character; or a name
  // (Arabic, Cyrillic, CJK, emoji) that `slugify` leaves nothing of, so there is no address yet.
  // Only once the user is under way, so a screen they have not touched yet says nothing.
  const started = name.trim().length > 0 || orgEdited;
  const needsName = creating && started && !longEnough;
  const needsAddress = creating && longEnough && !checkableSlug(address);

  const pickAddress = (s: string) => {
    setEdited(true);
    setSlug(s);
  };

  const label = !card ? "Create organization" : card.kind === "member" ? `Continue to ${card.name}` : `Join ${card.name}`;
  /** The first organization on offer to join; the "many organizations" line is about that one. */
  const offered = cards.find((c) => c.kind !== "member");

  const submit = () =>
    startBusy(async () => {
      setProblem(null);
      setNameError(null);
      const guard = async <T,>(run: () => Promise<T>, failed: T): Promise<T> =>
        run().catch((err: unknown) => {
          unstable_rethrow(err);
          return failed;
        });

      const saved = await guard(() => saveName(name), { ok: false as const, error: FAILED });
      if (!saved.ok) {
        setNameError(saved.error);
        return;
      }

      const target = address;
      const result = await guard<JoinResult | CreateResult>(
        () =>
          !card
            ? createOrganization(orgName, target)
            : card.kind === "invitation"
              ? acceptInvitation(card.id)
              : joinOrganization(card.slug),
        { ok: false as const, error: FAILED },
      );
      if (result.ok) {
        router.push(result.href);
        return;
      }
      if ("suggestions" in result) {
        // Taken between the check and the click: say so on the field, with the API's suggestions.
        setChecked({ slug: target, status: { kind: "taken", suggestions: result.suggestions, raced: true } });
        return;
      }
      setProblem(result.error);
      // An invitation or a domain match that no longer stands: reload what is on offer.
      if (!creating) router.refresh();
    });

  return (
    <ObShell
      eyebrow="02:14 AM"
      headline={["One screen,", "then you’re in."]}
      body="Your name and where your projects live. Everything else can wait until there is data to look at."
      receipt={
        <>
          project · <b>my-api</b> · production
        </>
      }
      badge="user"
      title="Welcome to APILens"
      lead="Tell us your name and where your projects should live."
    >
      <div className="ob-f">
        <label className="ob-l" htmlFor="welcome-name">
          Full name
        </label>
        <div className={`ob-in${nameError ? " bad" : ""}`}>
          <ObIcon name="user" />
          <input
            id="welcome-name"
            autoFocus
            autoComplete="name"
            placeholder="Ada Lovelace"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "welcome-name-err" : undefined}
          />
        </div>
        {nameError ? (
          <p id="welcome-name-err" className="ob-err" role="alert">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="ob-picks wc-picks" role="radiogroup" aria-label="Organization">
        {cards.map((c) => (
          <button
            key={c.slug}
            type="button"
            role="radio"
            aria-checked={chosen === c.slug}
            className={`ob-pick${chosen === c.slug ? " on" : ""}`}
            data-testid="welcome-org"
            onClick={() => setPicked(c.slug)}
          >
            <span className="rd" />
            <span className="cp-orgmark wc-mark" aria-hidden="true">
              {(c.name.trim()[0] ?? c.slug[0] ?? "?").toUpperCase()}
            </span>
            <span className="tx">
              <b>{c.kind === "member" ? c.name : `Join ${c.name}`}</b>
              <CardLines card={c} domain={domain} />
            </span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={creating}
          className={`ob-pick${creating ? " on" : ""}`}
          data-testid="welcome-create"
          onClick={() => setPicked(CREATE)}
        >
          <span className="rd" />
          <span className="wc-mark wc-mark--new" aria-hidden="true">
            +
          </span>
          <span className="tx">
            <b>Create a new organization</b>
            <small>For a personal project or a different team</small>
          </span>
        </button>
      </div>

      {creating ? (
        <div className="wc-new">
          <div className="ob-f">
            <label className="ob-l" htmlFor="welcome-org">
              Organization name
            </label>
            <div className={`ob-in${needsName ? " bad" : ""}`}>
              <ObIcon name="building" />
              <input
                id="welcome-org"
                autoComplete="organization"
                maxLength={100}
                value={orgName}
                onChange={(e) => {
                  setOrgEdited(true);
                  setTypedOrg(e.target.value);
                }}
                aria-invalid={needsName || undefined}
                aria-describedby={needsName ? "welcome-org-err" : undefined}
              />
            </div>
            {needsName ? (
              <p id="welcome-org-err" className="ob-err">
                Enter a name of at least two characters.
              </p>
            ) : null}
          </div>
          <div className="ob-f">
            <label className="ob-l" htmlFor="welcome-slug">
              Address<small>used in links and the CLI</small>
            </label>
            <div className={`ob-in${taken || needsAddress ? " bad" : ""}`}>
              <ObIcon name="link" />
              {host ? <span className="pre">{host}/org/</span> : null}
              <input
                id="welcome-slug"
                value={address}
                onChange={(e) => pickAddress(slugify(e.target.value))}
                aria-invalid={taken || needsAddress}
                aria-describedby={taken || needsAddress ? "welcome-slug-err" : undefined}
              />
              <span className="r" aria-live="polite">
                {mine ? (
                  <>
                    <ObIcon name="done" />
                    Yours
                  </>
                ) : status.kind === "available" ? (
                  <>
                    <ObIcon name="done" />
                    Available
                  </>
                ) : status.kind === "checking" ? (
                  <span className="wc-muted">Checking…</span>
                ) : taken ? (
                  <span className="wc-bad">Taken</span>
                ) : null}
              </span>
            </div>
            {needsAddress ? (
              <p id="welcome-slug-err" className="ob-err">
                Your organization name doesn’t give an address. Enter one: lower-case letters, digits and hyphens.
              </p>
            ) : null}
            {taken ? (
              <p id="welcome-slug-err" className="ob-err">
                {status.raced ? "Someone just took that address." : "That address is taken."}{" "}
                {status.suggestions.length > 0 ? (
                  <>
                    Try{" "}
                    {status.suggestions.map((s, i) => (
                      <Fragment key={s}>
                        {i > 0 ? ", " : null}
                        <button type="button" className="cp-link" onClick={() => pickAddress(s)}>
                          {s}
                        </button>
                      </Fragment>
                    ))}
                    .
                  </>
                ) : (
                  "Try adding your region or team."
                )}
              </p>
            ) : null}
          </div>
          <div className="ob-note wc-note">
            <ObIcon name="folder" />
            <span>
              We’ll create your first project, <b>my-api</b>, with a <b>production</b> environment. You can rename it or add
              more later.
            </span>
          </div>
        </div>
      ) : null}

      {problem ? (
        <div className="ob-notice ob-notice--error" role="alert">
          <ObIcon name="info" />
          <p>{problem}</p>
        </div>
      ) : null}

      {offered ? (
        <p className="ob-p wc-many">
          One account can belong to many organizations. You can join {offered.name} now and create your own later, or the other way round.
        </p>
      ) : null}

      {/* Inline, not the shell's footer: that pins to the panel's bottom, stranding the button. */}
      <div className="wc-go">
        <button
          type="button"
          className={`ah-btn ah-btn--primary${busy ? " is-loading" : ""}`}
          disabled={!ready || busy}
          aria-busy={busy || undefined}
          onClick={submit}
        >
          {label}
          <ObIcon name="next" />
        </button>
      </div>
    </ObShell>
  );
}
