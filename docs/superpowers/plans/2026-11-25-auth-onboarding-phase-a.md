# Auth and Onboarding — Phase A (fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what is broken in sign-in, account and organization flows before the Phase B onboarding rewrite.

**Architecture:** Go identity/controlplane changes are small and test-first (unit with fakes, integration with
`-tags=integration` where SQL changes); the Next.js UI follows the existing `lib/` (pure, unit-tested) +
`components/` + `app/` split, with e2e-fake specs for flows.

**Tech Stack:** Go 1.27 (huma, sqlc, pgx), Next.js 16 + React 19, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-auth-onboarding-design.md` (Phase A items 1–6, 10–14).
Mockups: https://claude.ai/artifact/P3REYXR3WyPBzD3LQZshRN

## Scope notes (decided while planning)

- Item 5 ("Sign out of all devices") already exists: Settings → Sessions has "Sign out other sessions"
  (`components/account-settings/sessions.tsx`). No task.
- Items 7–9 and 13 (domain-join mislabel, invited home pick, About's Back, onboarding type/stage cleanup)
  concern screens that Phase B deletes. No task here; Phase B's plan covers them.
- Item 14 ships the "admin's own verified email domain" rule plus one-domain-one-org. DNS TXT verification
  is deferred to Phase B's plan (it needs a token table and a checker job).
- The delete-account UI already maps `owner_transfer_required` (`lib/profile.ts`); item 4 is backend wiring only.

## Global Constraints

- Branch `feat/auth-onboarding`; commits signed off (`git commit -s`), Conventional Commits titles.
- No AI attribution lines in commits or PRs.
- Generated code is committed: after changing a SQL query or an API operation run `task gen` (sqlc + OpenAPI) and commit the output.
- Keep code comments few and short (repo and user preference).
- Before running anything locally: `set -a; . ./dev.local.env; set +a` (dev datastores on ports 25432 / 29000).
- Session lengths stay as configured: remember → `identity.refresh_token_ttl` (30 d), else `refresh_token_ttl_short` (24 h).

## Review Focus

1. OAuth/SSO sign-in that hits **2FA** must keep the user's remember choice through the pre-auth cookie, not just the direct session path (Task 1 + 2 tests cover both branches).
2. A user who **unticks** "Keep me signed in" and uses Google must get a 24 h cookie — the old code forced 30 d (Task 2 test `oauthStartUrl … remember=false`).
3. Account deletion when the user is the sole owner of a **soft-deleted** org must still be allowed (Task 5 integration case).
4. Saving org settings that **keep** a previously stored domain the admin's email is not at must still succeed (Task 7 unit case "existing domain kept").
5. An SSO user who already **had** an account must not have onboarding forced complete or next rewritten (Task 4 unit case "existing user").

---

### Task 1: Handoff carries the remember choice (Go)

**Files:**
- Modify: `internal/identity/signin.go` (SignInResponse)
- Modify: `internal/identity/oauth_callback.go:~395-420`, `internal/identity/sso.go:~455-490`
- Test: `internal/identity/oauth_callback_test.go`, `internal/identity/sso_test.go`
- Regenerate: `api/openapi/apilens.v1.json`, `internal/gen/...` via `task gen:openapi`

**Interfaces:**
- Produces: `SignInResponse.Remember bool` JSON `remember,omitempty` — set on both the session and the
  `2fa_required` answers that OAuth and SSO callbacks put in the handoff store. Email/passkey answers leave it unset.

- [ ] **Step 1: Write failing tests** — `TestOAuthCallbackHandoffCarriesRemember` (table: state `Remember` true/false × 2FA on/off; assert the stored handoff `SignInResponse.Remember` equals state) and `TestSSOCallbackHandoffCarriesRemember` (same table) using the existing fakes in those files.
- [ ] **Step 2: Run** `go test ./internal/identity/ -run 'HandoffCarriesRemember' -count=1` — expect FAIL (`Remember` undefined).
- [ ] **Step 3: Implement** — add the field with doc `"Echo of the remember choice for OAuth/SSO handoffs, so the UI sets a matching cookie."`; set `resp.Remember = st.Remember` after `NewSignInSession` / `NewSignInTwoFactor` in both callbacks.
- [ ] **Step 4: Run** the same command — PASS; then `go test ./internal/identity/... -count=1` — PASS.
- [ ] **Step 5:** `task gen:openapi` and `task openapi:check` — clean.
- [ ] **Step 6: Commit** `feat(identity): echo remember in OAuth and SSO handoffs`.

### Task 2: One "Keep me signed in" choice for every method (UI)

**Files:**
- Modify: `apps/ui/src/lib/oauth.ts` (remove `OAUTH_REMEMBER`), `apps/ui/src/lib/sso.ts` (remove `SSO_REMEMBER`),
  `apps/ui/src/lib/identity.ts` (`SignInResult.remember?: boolean`)
- Modify: `apps/ui/src/components/onboarding/sign-in.tsx`, `sign-up.tsx`, `sso.tsx`, `verify.tsx`, `keep-signed-in.tsx`
- Modify: passkey login call in `sign-in.tsx` and `apps/ui/src/app/api/auth/passkeys/login/verify/route.ts` (forward `remember`)
- Test: `apps/ui/src/lib/oauth.test.ts`, `apps/ui/src/lib/sso.test.ts`, `apps/ui/e2e-fake/oauth.spec.ts`

**Interfaces:**
- Consumes: Task 1 `remember` in the handoff result.
- Produces:
  - `oauthStartUrl(apiBase: string, provider: OAuthProvider, opts: { next?: string; remember: boolean }): string`
  - `oauthStartLinks(methods: SignInMethods, opts: { next?: string; remember: boolean }, apiBase?: string): OAuthLinks`
  - `ssoStartHref(startUrl: unknown, opts: { email?: string; next?: string; remember: boolean }): string | null`
  - `/verify?…&remember=0|1` — the verify page initializes its checkbox from it (default `1`).

- [ ] **Step 1: Write failing unit tests**
  - `oauthStartUrl` with `remember: false` → URL has `remember=false`; with `true` → `remember=true`.
  - `exchangeHandoff`: result `{…, remember: false}` → `Set-Cookie` has no `Max-Age`/`Expires` beyond the short session (assert via existing cookie helper used in `oauth.test.ts`); result with `status: "2fa_required", remember: false` → pre-auth cookie payload `r:false`; result with `remember` absent → treated as `true` (back-compat with an older API).
  - `ssoStartHref(url, { remember: false })` → `remember=false`.
- [ ] **Step 2: Run** `pnpm --filter ui test -- oauth sso` — FAIL.
- [ ] **Step 3: Implement** — `KeepSignedIn` control (existing component, default checked) moves onto sign-in and sign-up below the email field, as in the mockup; its state feeds the provider links (rebuilt when toggled), SSO start, passkey verify body `remember`, and the `/verify` URL. `exchangeHandoff` uses `result.remember ?? true`.
- [ ] **Step 4: Run** unit tests — PASS; `pnpm --filter ui typecheck` — clean.
- [ ] **Step 5: e2e-fake** — in `oauth.spec.ts` add "unticked keep-signed-in gives a session cookie" (assert the `apilens_session` cookie has `expires === -1`); run `pnpm --filter ui test:e2e:fake -- oauth` — PASS.
- [ ] **Step 6: Commit** `feat(web): one keep-me-signed-in choice for every sign-in method`.

### Task 3: SSO button shows when an SSO connection exists

**Files:**
- Modify: `internal/identity/providers.go`, the `RegisterProviders` call in `internal/app/app.go`
- Modify: `internal/identity/store/queries/` — add query in the identity store file that holds SSO lookups (`AnySSOConnection :one` → `SELECT EXISTS (SELECT 1 FROM org_sso_connections c JOIN organizations o ON o.id = c.org_id WHERE o.deleted_at IS NULL)`)
- Modify: `apps/ui/src/components/onboarding/sign-in.tsx`, `sign-up.tsx` (button placement)
- Test: `internal/identity/providers_test.go`, `apps/ui/e2e-fake/org-sso.spec.ts`

**Interfaces:**
- Produces: `type SSOAvailability interface { AnySSOConnection(ctx context.Context) (bool, error) }`;
  `RegisterProviders(api huma.API, cfg config.IdentityConfig, sso SSOAvailability)` — `SSO` computed per request; a lookup error logs and answers `false`.

- [ ] **Step 1: Write failing test** `TestProvidersSSOFollowsConnections` — fake returning true → body `sso: true`; false → `false`; error → `false` and 200.
- [ ] **Step 2: Run** `go test ./internal/identity/ -run TestProvidersSSO -count=1` — FAIL.
- [ ] **Step 3: Implement**; `task gen:sqlc`; drop the "SSO is not available yet" comment.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: UI** — "Continue with SSO" is a full-width button directly under GitHub on sign-in and sign-up (mockup screens 1 and 1b), rendered only when `providers.sso`. Remove the bottom text link. e2e-fake: `org-sso.spec.ts` "SSO button sits under the social buttons when providers.sso" — PASS.
- [ ] **Step 6: Commit** `feat(identity): advertise SSO when a connection exists`.

### Task 4: Sign-up by code for an existing account, and SSO-created members, land correctly

**Files:**
- Modify: `apps/ui/src/lib/email-verify.ts`, `apps/ui/src/components/onboarding/verify.tsx:~106`
- Modify: `internal/identity/sso.go` (`signInUser`), `internal/identity/users/users.go`
- Test: `apps/ui/src/lib/email-verify.test.ts`, `internal/identity/sso_test.go`, `internal/identity/users/users_integration_test.go`

**Interfaces:**
- Produces:
  - `verifyNext(asked: string | undefined): string | undefined` in `lib/email-verify.ts` — returns `asked` only (the server picks onboarding for new users).
  - `func (s *Service) CompleteOnboarding(ctx context.Context, id uuid.UUID) error` in `users` — merges `{"step":"done","completed_at":<now RFC3339>}` via `UpdateUserOnboarding`.
  - `SSOUsers` interface (in `sso.go`) gains `CompleteOnboarding(ctx, id uuid.UUID) error`.

- [ ] **Step 1: Write failing tests**
  - vitest: `verifyNext(undefined)` → `undefined` for both flows; `verifyNext("/invite/abc")` → `"/invite/abc"`.
  - Go unit `TestSSONewMemberSkipsOnboarding`: fake users `created=true`, memberships `joined=true`, state `Next=""` → response `Next == "/"` and fake recorded `CompleteOnboarding(user.ID)`.
  - Go unit, Review Focus #5: `created=false` → `CompleteOnboarding` not called, `Next` unchanged.
  - Go integration `TestCompleteOnboarding`: after the call, `onboarding->>'step' = 'done'` and `completed_at` set.
- [ ] **Step 2: Run** `pnpm --filter ui test -- email-verify` and `go test ./internal/identity/ -run TestSSONewMember -count=1` — FAIL.
- [ ] **Step 3: Implement** — verify.tsx calls `verifyNext(asked)`; in `signInUser`, when `created && joined`, call `CompleteOnboarding` and set `next = "/"` (only if `st.Next` empty or `/`).
- [ ] **Step 4: Run** unit tests, then `go test -tags=integration -count=1 ./internal/identity/users/ -run TestCompleteOnboarding` — PASS.
- [ ] **Step 5: e2e-fake** — `sso.spec.ts:130` now expects the org landing, not `/onboarding/about`; run it — PASS.
- [ ] **Step 6: Commit** `fix(identity): SSO members and returning sign-ups skip onboarding`.

### Task 5: The sole owner of an organization cannot delete their account

**Files:**
- Modify: `internal/controlplane/store/queries/memberships.sql` (new query), `internal/app/app.go:675-677`
- Create: `internal/controlplane/orgs/ownership.go`
- Test: `internal/controlplane/orgs/ownership_integration_test.go`, `internal/identity/me_integration_test.go`

**Interfaces:**
- Produces: query `SoleOwnedOrganizations :many` — org ids where the user is an owner, the org is not soft-deleted, and no other non-deleted owner exists; `type Ownership struct{…}`, `func NewOwnership(q db.DBTX) *Ownership`, `func (o *Ownership) SoleOwnedOrgs(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error)` satisfying `account.OwnershipChecker`.

- [ ] **Step 1: Write failing integration tests** — cases: sole owner → 1 id; two owners → none; co-owner deleted account → counts as sole; org soft-deleted → none (Review Focus #3); member-only → none. Plus in `me_integration_test.go`: `DELETE /users/me` for a sole owner answers 409 `owner_transfer_required`.
- [ ] **Step 2: Run** `go test -tags=integration -count=1 -p 1 ./internal/controlplane/orgs/ -run Ownership` — FAIL.
- [ ] **Step 3: Implement** the query (`task gen:sqlc`) and `Ownership`; wire `account.New(a.pool, orgs.NewOwnership(a.pool))`, removing the #276 comment.
- [ ] **Step 4: Run** both integration packages — PASS.
- [ ] **Step 5: Commit** `fix(account): block deletion while sole owner of an organization`.

### Task 6: No landing on "Coming soon" pages

**Files:**
- Modify: `apps/ui/src/lib/data.ts:53`, `apps/ui/src/lib/landing.ts` (`HOME_SCREEN_VIEW`, `HOME_SCREEN_CHOICES`)
- Modify: `apps/ui/e2e/onboarding.spec.ts:140`, `apps/ui/e2e-fake/home-screen.spec.ts`
- Test: `apps/ui/src/lib/landing.test.ts`

**Interfaces:**
- Produces: `HOME_VIEW = "traffic"`; `HOME_SCREEN_VIEW.exceptions = "traffic"` (Errors is Coming soon); `HOME_SCREEN_CHOICES` lists only `endpoints` and `requests`.

- [ ] **Step 1: Write failing tests** — `homeView` with no preference → `"traffic"`; with `exceptions` → `"traffic"`; `HOME_SCREEN_CHOICES.map(c => c.id)` → `["endpoints","requests"]`.
- [ ] **Step 2: Run** `pnpm --filter ui test -- landing` — FAIL.
- [ ] **Step 3: Implement**; update the two e2e expectations to `/traffic`.
- [ ] **Step 4: Run** unit + `pnpm --filter ui test:e2e:fake -- home-screen` — PASS.
- [ ] **Step 5: Commit** `fix(web): default home is Traffic, never a Coming soon page`.

### Task 7: A domain can only be claimed by its own people, and by one organization

**Files:**
- Modify: `internal/controlplane/orgs/manage.go` (`validate`/`Update`), `internal/controlplane/store/queries/organizations.sql`
- Modify: `internal/controlplane/api/orgs.go:~316`, `internal/controlplane/api/sso.go:~175` (same rule for SSO domains)
- Modify: `apps/ui/src/lib/org-settings.ts` (messages)
- Test: `internal/controlplane/orgs/manage_test.go`, `internal/controlplane/orgs/manage_integration_test.go` (create if missing), `internal/controlplane/api/orgs_test.go`, `apps/ui/src/lib/org-settings.test.ts`

**Interfaces:**
- Produces:
  - query `OrganizationClaimingDomain :one` — `SELECT id FROM organizations WHERE @domain::text = ANY(allowed_domains) AND deleted_at IS NULL AND id <> @org_id LIMIT 1`
  - `type DomainNotVerifiedError struct{ Domain string }` → 422 `domain_not_verified`
  - `type DomainTakenError struct{ Domain string }` → 409 `domain_taken`
  - Rule: each domain **added** (not already in `cur.AllowedDomains`) must equal the domain of the acting user's verified email (`GetUserEmail`, `email_verified_at` not null); every domain in the new list must not be claimed by another active org.

- [ ] **Step 1: Write failing tests**
  - unit: admin `ada@acme.dev` adds `acme.dev` → ok; adds `globex.com` → `DomainNotVerifiedError`; list `[old.io, acme.dev]` where `old.io` was already stored → ok (Review Focus #4).
  - integration: org B adding `acme.dev` already on org A → `DomainTakenError`; after A is soft-deleted → ok.
  - api: error → status/code mapping rows for both new errors.
  - vitest: `orgSettingsError("domain_not_verified")` mentions "your own email domain"; `"domain_taken"` mentions "another organization".
- [ ] **Step 2: Run** `go test ./internal/controlplane/... -run Domain -count=1` — FAIL.
- [ ] **Step 3: Implement** (`task gen:sqlc`); check runs inside the `Update` transaction after `lockMember`.
- [ ] **Step 4: Run** unit, `go test -tags=integration -count=1 -p 1 ./internal/controlplane/orgs/ -run Domain`, vitest — PASS.
- [ ] **Step 5: Commit** `fix(orgs): only verified, unclaimed domains can allow joining`.

### Task 8: Create organization and Create project after onboarding

**Files:**
- Create: `apps/ui/src/app/organizations/new/page.tsx`, `apps/ui/src/app/org/[org]/projects/new/page.tsx`
- Create: `apps/ui/src/app/organizations/new/actions.ts`, `apps/ui/src/app/org/[org]/projects/new/actions.ts`
- Modify: `apps/ui/src/components/scope-tree.tsx:53-57,103-107` (buttons → links), `apps/ui/src/components/org/projects.tsx` (empty state button + header "New project")
- Modify: `apps/ui/src/lib/routes.ts`
- Reuse: form parts of `components/onboarding/create-org.tsx` and `create-project.tsx` (name, live slug check, environments)
- Test: `apps/ui/src/lib/routes.test.ts`, new `apps/ui/e2e-fake/create-org-project.spec.ts`

**Interfaces:**
- Produces: `newOrgHref(): "/organizations/new"`; `newProjectHref(org: string): string` → `/org/{org}/projects/new`.
  Server actions call the existing `POST /orgs` and `POST /orgs/{org}/projects`; success redirects to `/org/{slug}` and
  `/project/{slug}/traffic` respectively. The new-project page has an organization select (orgs where the user can create projects).

- [ ] **Step 1: Write failing tests** — vitest for the two hrefs; e2e-fake: (a) scope menu "Create organization" → form → lands on `/org/side-project-labs` showing "Create your first project"; (b) empty-org button → new-project form → lands on `/project/payments-service/traffic`; (c) slug taken shows the existing inline message.
- [ ] **Step 2: Run** `pnpm --filter ui test -- routes` and `pnpm --filter ui test:e2e:fake -- create-org-project` — FAIL.
- [ ] **Step 3: Implement** pages and actions matching mockup screen 7 (tabs "New project" / "New organization" are two routes; the tab bar links between them). Empty org state copy: title "No projects in {org} yet", button "Create your first project".
- [ ] **Step 4: Run** the tests, plus `pnpm --filter ui typecheck` and `pnpm --filter ui lint` — PASS.
- [ ] **Step 5: Commit** `feat(web): create organizations and projects after onboarding`.

### Task 9: Docs and full verification

**Files:**
- Modify: `docs/architecture/identity.md` (status table lines ~14-53: SSO advertised, remember echo, ownership check, domain rule)
- Modify: `apps/docs/account/sign-in-and-2fa.mdx` (keep-me-signed-in applies to every method), `apps/docs/account/members-and-invitations.mdx` (domain rule)

- [ ] **Step 1:** Update the docs above.
- [ ] **Step 2: Run** `task lint`, `task test`, `task test:integration`, `pnpm --filter ui test`, `pnpm --filter ui test:e2e:fake` — all PASS (report any pre-existing failures separately with output).
- [ ] **Step 3: Manual check** on the dev stack (http://localhost:3200): sign up with Google unticked → cookie is a session cookie; sole owner delete → blocked message; scope menu creates org and project.
- [ ] **Step 4: Commit** `docs: Phase A auth and onboarding fixes`.
