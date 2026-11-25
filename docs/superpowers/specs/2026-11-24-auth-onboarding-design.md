# Auth and onboarding rework — design

Date: 2026-11-24 · Branch: `feat/auth-onboarding` (from `ui/round2-base`)

## Why

APILens has no customers yet, so the sign-in and first-run experience can be reshaped freely: no
onboarding state to migrate, no flows to keep backwards compatible. Today the flow works but is
long (9 onboarding screens), has dead ends (no way to create a second org or project), and has
correctness gaps (SSO users pushed to create an org, owners can delete their account). The goal is a
flow that is correct first, then as short as Apitally's and as polished as Sentry's.

## Goals

- Every sign-in method (email code/link, Google, GitHub, passkey, SSO) lands a user in the right
  place: new users in onboarding, members of an org in that org, invited users in the invited org.
- Onboarding takes about four screens from sign-up to "waiting for first request".
- After onboarding, users can always create another org or project and are never left on an empty
  page.

## Non-goals (Phase C, later)

Request-to-join and member invite requests, org-enforced 2FA, SAML and SCIM, region choice, plans,
trials and billing, the self-host `apilens user create` / `magic-link` CLI (#353).

## Anti-goals

- No email + password. Sign-in stays passwordless (email code or link, OAuth, passkeys, SSO).
- No questionnaires (role, team size, referral source) in the required path.
- Tokens never reach the browser; the existing encrypted-cookie and handoff model stays.

## Benchmark summary

| | Apitally | Sentry | DevRev | APILens today |
|---|---|---|---|---|
| First screen | name + team name | org name + region | name, org, slug, region | home-screen pick |
| Steps to SDK snippet | ~4 | ~4 | n/a | 6 |
| Demo path | shared demo team | sandbox + sample error | ? | none |
| Agent prompt | yes | yes | n/a | no |
| Waiting for first event | ? | 1 s poll | n/a | poll + test curl |

Apitally, Sentry and DevRev details come from a research pass on 2026-11-24, using their docs and the
code their web apps ship.

## Current state (what exists)

- Identity in Go (`internal/identity`): email code/link (`email_start.go`, `email_verify.go`,
  `email_link.go`), Google/GitHub OAuth with one-time handoff codes, passkeys, TOTP 2FA with
  pre-auth tokens, per-org OIDC SSO, re-auth for sensitive actions, account recovery. Users are
  created in `users.FindOrCreateByVerifiedEmail`.
- Session: RS256 access JWT (15 min) + single-use refresh token, held server-side in the UI's
  encrypted `apilens_session` cookie; route guard in `apps/ui/src/proxy.ts` + `lib/auth-gate.ts`.
- Onboarding state: `users.onboarding` jsonb `{step, answers, completed_at}`, written by
  `PATCH /users/me/onboarding`, guarded per page by `requireOnboardingStep`.
- Onboarding screens: about → join → create → project → instrument → install → waiting →
  first-data → invite (`apps/ui/src/app/(auth)/onboarding/*`).

## Design

### Phase A: fix what is broken

**Auth**

1. **Remember me works the same for every method.** One "Keep me signed in" choice on sign-in and
   sign-up, carried through email, OAuth, SSO and passkey sign-in. Today OAuth and SSO are always
   30 days and passkeys always 24 h.
2. **SSO shows up when it is configured.** `providers.sso` reflects whether an SSO connection
   exists (`providers.go`).
3. **Code sign-up only sends new accounts into onboarding.** Verifying a code with `intent=signup`
   for an existing account lands like sign-in (`verify.tsx` forces `/onboarding/about` today).
4. **Owners can't orphan an org.** Account deletion uses the real membership checker: the sole owner
   of an org must transfer ownership or delete the org first (`app.go` still wires
   `account.NoMemberships{}`).
5. **"Sign out of all devices"** in Settings → Security, calling the existing `/auth/logout-all`.

**Routing and onboarding**

6. SSO-created users (already members via the connection's default role) skip org creation and land
   in their org.
7. A user who joined by email domain is not mistaken for an invited user (no finishing onboarding
   without a project).
8. Invited users keep their home-screen choice.
9. Onboarding Back buttons go somewhere real or are removed (About's Back loops today).
10. No landing on "Coming soon" pages: the default home and every selectable home map to live views
    (Traffic by default).
11. "Create organization" and "Create project" work after onboarding: real create pages reached from
    the scope menu and the org's projects list, using the existing `POST /orgs` and
    `POST /orgs/{org}/projects`.
12. An org with no projects shows a "Create your first project" empty state.
13. Cleanup: drop the unused `requests` stage, align `OnboardingState` with the context endpoint,
    remove stale comments (`providers.go`, `app.go`).

### Phase A addition (from the org-collision review)

14. **Only verified domains offer "Join".** Today any org admin can add any domain to
    `allowed_domains`, so a stranger's org can appear as "Join" for every @acme.dev user. A domain
    is accepted only when verified (the admin's own verified email is at that domain, or a DNS TXT
    record `apilens-verify=<token>`), and one domain can belong to at most one organization.

### Phase B: the new onboarding

Approved mockups: https://claude.ai/artifact/P3REYXR3WyPBzD3LQZshRN (2026-11-25).

Target flow:

```
sign-up / sign-in ─▶ verify ─▶ Welcome (name + join Acme | create org) ─▶ project Traffic page, first-run guide
                                                                              └─ data arrives ─▶ "Open your dashboard" ─▶ normal Traffic
```

15. **Sign-up and sign-in share one layout.** Google, GitHub and "Continue with SSO" are stacked
    buttons, then email; sign-in adds "Sign in with passkey" at the top and a "Last time you signed
    in as …" line. One "Keep me signed in for 30 days" checkbox (item 1).
16. **Welcome is the only onboarding screen.** Full name (prefilled from the Google, GitHub or SSO
    profile; new: the profile name is copied to `users.name` on first sign-in) and an organization
    choice: "Join <org>" cards for verified-domain matches and pending invites, or "Create a new
    organization" (name prefilled "{First name}'s org", live slug check). One account can belong to
    many orgs; joining never blocks creating. No step bar.
17. **First project is created with the org.** Creating an org also creates project `my-api` with
    environment `production` and an ingest key, so the user lands inside a real project.
    Joining an org lands on that org's last or first project.
18. **First-run guide on the Traffic page** (no separate Home page; the real nav stays). While the
    project has no data:
    - Header "Send your first request to <project>" and a pulsing "Listening for requests…" chip.
    - Left: numbered guide — 1 framework (FastAPI / Express / Spring Boot segmented control, plus
      "Copy prompt for your coding agent"), 2 install command, 3 middleware snippet with the key
      filled in (masked, reveal), 4 restart + curl, with a "Nothing after 2 minutes?" help block.
    - Right: "What you'll see" preview labelled *Example data* (sparkline, three endpoints, one 500
      row) and a text link "Explore a full demo project →".
    - First request arrives: the chip turns green and shows the real request (method, path,
      status, duration) and an "Open your dashboard" button appears. No automatic redirect.
    - After that: the normal Traffic page with one dismissable "Next: identify your consumers" strip.
19. **Empty product pages** (Endpoints, Consumers, Explore, Performance): one sentence, a "Connect
    your API" button leading to the guide, and "See it with demo data". Errors distinguishes "no
    data yet" from "no errors yet".
20. **Quick start popover** in the top bar ("N left" badge), five skippable items, each opening the
    right page: send your first request, identify your consumers, hide sensitive fields, invite a
    teammate, add a passkey. Replaces the onboarding invite step and any permanent checklist.
21. **"Connect API" button** in the top bar while the project has no data, opening the guide.
22. **Passkey offer** after a successful first sign-in on a device that supports it (skippable,
    never shown again once dismissed); the Quick start item covers it otherwise.
23. **Onboarding state** shrinks to `{step: "welcome" | "done"}`; the old step values are simply
    replaced (no users, no data migration). Old onboarding routes (`about`, `join`, `create`,
    `project`, `instrument`, `install`, `waiting`, `first-data`, `invite`) are removed.
24. **Demo project** (last in Phase B, cuttable): a shared read-only project filled by a background
    traffic generator, opened from "Explore a full demo project", with a persistent "You're viewing
    demo data · Back to <project>" banner.

### Throughout

25. Tests: update `e2e/onboarding.spec.ts` and `e2e-fake/onboarding*.spec.ts`; add Go integration
    and e2e coverage for SSO, invited, domain-join and returning users.
26. Docs: `docs/architecture/identity.md`, the user docs in `apps/docs`, and
    `apps/docs/self-host/first-admin.mdx`.

## Approaches considered

- **Patch in place**: fix Phase A only and keep the 9-step flow. Low effort, but it keeps a flow
  that's twice as long as competitors'.
- **Redesign on the existing backend (chosen)**: fix Phase A, then replace the onboarding screens
  and state model. Identity, sessions, invites and the org/project APIs already do what the new flow
  needs, so most of the change is in the UI plus small backend additions (profile name, domain
  verification, org-with-first-project, demo project).
- **Rebuild identity on a hosted provider** (Auth0, Clerk): rejected; the built-in identity
  (ADR 0005) already covers more methods than Apitally and is required for self-host.

For the first-run page, three layouts were compared (research on Sentry, PostHog, Supabase, Moesif,
Apitally, Stripe): setup inside the real page with an example preview (chosen), a focused install
step that waits (hides the product), and a drawer only (weak first impression).

## Decided by the user

- Phase C is deferred; Phases A and B are in scope. Backup personal email (for work-email accounts
  that own a personal org) is Phase C.
- Product setup is not part of onboarding; it lives in the app (first-run guide, empty states).
- Demo data is shown only as a secondary link, never as an equal choice.
- Mockups approved 2026-11-25; work proceeds item by item on `feat/auth-onboarding`.

## Calls made without asking (correct any of these)

- Passwordless only; no region picker; no billing step.
- Home-screen preference moves to Settings; default home is Traffic.
- First project `my-api` is created automatically with the org.

## Left to the builder

Exact copy, the coding-agent prompt text per framework, how the demo traffic generator is scheduled,
and how the scope menu presents create actions.
