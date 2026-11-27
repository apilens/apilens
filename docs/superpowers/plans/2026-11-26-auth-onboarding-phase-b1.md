# Phase B1 — the one-screen Welcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the nine-screen onboarding with one Welcome screen that takes a name and an organization choice, then drops the user inside a real project.

**Architecture:** The backend already creates organizations, projects and memberships; this is mostly UI plus three small backend additions (the profile name reaching `users.name`, the signed-in user's pending invitations, and the shrunken onboarding state). Welcome is a Server Component with Server Actions that call the existing `POST /orgs`, `POST /orgs/{org}/projects` and join/accept endpoints; the old step machine (`stageOf`, the step bar, nine routes) is deleted rather than adapted.

**Tech Stack:** Go 1.27 (huma v2, sqlc, pgx), Next.js 16 / React 19, vitest, Playwright (`e2e/` real, `e2e-fake/` mocked).

**Spec:** `docs/superpowers/specs/2026-11-24-auth-onboarding-design.md` — Phase B items 15, 16, 17, 23 (items 18–22 and 24 are the later Phase B plans listed at the end).

**Branch:** `feat/auth-onboarding`, on top of Phase A (`9bf7ef75`).

## Global Constraints

- One account may belong to many organizations; joining one never blocks creating another (spec item 16).
- No step bar, no progress chrome: Welcome is the only onboarding screen (item 16).
- The first project is `my-api` with the single environment `production` (items 17, "Calls made without asking").
- Onboarding state is exactly `{step: "welcome" | "done"}`; no migration, no back-compat — there are no users yet (item 23).
- Passwordless only; no region picker, no billing step.
- Default home is Traffic; the home-screen preference lives in Settings (Phase A).
- Never add AI attribution to commits or docs (user rule). Keep code comments few and short (user rule).
- `task gen:sqlc` after any `.sql` change; `task gen:openapi` after any API change, and `api/openapi/apilens.v1.json` is committed with it.

## Review Focus

1. **A user with organizations lands on Welcome** (returning user whose onboarding never completed, or an SSO member): Welcome must offer their existing organizations and never create a second one silently — pinned in Task 5.
2. **Organization created, project creation fails** (API error between the two calls): onboarding still completes and the user lands on the organization page with "Create your first project", never on a dead URL — pinned in Task 4.
3. **An invitation accepted, revoked or expired in another tab** while Welcome is open: the card answers with a sentence, not a 500 — pinned in Task 2.
4. **The chosen organization has no project** (joined an empty org): landing picks the organization page, not `/project/undefined/...` — pinned in Task 4.
5. **A profile name that is empty, whitespace, 300 characters or emoji** from Google/GitHub/SSO: stored trimmed and bounded, never overwriting a name the user has already set — pinned in Task 1.

---

### Task 1: The provider's profile name reaches `users.name`

Today Google, GitHub and SSO store the profile JSON on the identity row and leave `users.name` null, so Welcome has nothing to prefill.

**Files:**
- Create: `internal/identity/store/queries/user_name.sql`
- Modify: `internal/identity/users/users.go`, `internal/identity/oauth_callback.go` (`PGSignInUsers.FindOrCreateOAuth`), `internal/identity/sso.go` (`signInUser`)
- Test: `internal/identity/users/users_test.go`, `internal/identity/users/name_integration_test.go`

**Interfaces:**
- Produces: `users.ProfileName(profile map[string]any) string` — the trimmed `name` claim, empty when missing, blank or over 100 runes; `(*users.Service).SetNameIfEmpty(ctx context.Context, user uuid.UUID, name string) error` — no-op for an empty name or a user who already has one.

- [ ] **Step 1: Write the failing unit test** in `internal/identity/users/users_test.go`

```go
func TestProfileName(t *testing.T) {
	for _, c := range []struct{ in map[string]any; want string }{
		{map[string]any{"name": "  Ada Lovelace "}, "Ada Lovelace"},
		{map[string]any{"name": "   "}, ""},
		{map[string]any{"name": strings.Repeat("é", 101)}, ""},
		{map[string]any{"name": 42}, ""},
		{nil, ""},
	} {
		if got := ProfileName(c.in); got != c.want {
			t.Errorf("ProfileName(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/identity/users/ -run TestProfileName`
Expected: FAIL, `undefined: ProfileName`.

- [ ] **Step 3: Implement `ProfileName` and `SetNameIfEmpty`**

Add the query `SetUserNameIfEmpty :execrows` to `internal/identity/store/queries/user_name.sql`: `UPDATE users SET name = @name, updated_at = now() WHERE id = @id AND (name IS NULL OR btrim(name) = '')`. Run `task gen:sqlc`.

- [ ] **Step 4: Run the unit test and the package**

Run: `go test ./internal/identity/users/`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test** `TestSetNameIfEmptyIntegration` in `internal/identity/users/name_integration_test.go` (build tag `integration`): a user created with no name takes "Ada Lovelace"; a second call with "Someone Else" leaves it; a user who already has a name is untouched.

- [ ] **Step 6: Run it, watch it fail, then wire the callers**

Run: `go test -tags=integration ./internal/identity/users/ -run TestSetNameIfEmptyIntegration`
Call `SetNameIfEmpty(ctx, user.ID, ProfileName(ext.Profile))` in `FindOrCreateOAuth` only on the `created` branch, and the equivalent from the OIDC claims in `sso.go`'s `signInUser`. A failure here only logs: a missing name must never refuse a sign-in (the Phase A rule for `CompleteOnboarding`).

- [ ] **Step 7: Run the identity suites**

Run: `go test ./internal/identity/... && go test -tags=integration ./internal/identity/users/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/identity api/openapi
git commit -m "feat(identity): keep the provider's profile name on the user"
```

---

### Task 2: The signed-in user's pending invitations

Welcome shows "Join <org>" cards for invitations, which today only exist behind an emailed token.

**Files:**
- Modify: `internal/controlplane/store/queries/invitations.sql`, `internal/controlplane/orgs/invitations.go`, `internal/controlplane/api/invitations.go`, `apps/ui/src/lib/identity.ts`
- Test: `internal/controlplane/api/my_invitations_integration_test.go`

**Interfaces:**
- Produces: `GET /api/v1/users/me/invitations` → `[{id, org_slug, org_name, role, invited_by_name, expires_at}]`, pending and unexpired only, for the caller's verified address; `POST /api/v1/users/me/invitations/{id}/accept` → the joined `Org`. Client: `identity().listMyInvitations(o)`, `identity().acceptMyInvitation(id, o)`.

- [ ] **Step 1: Write the failing integration test** `TestMyInvitationsIntegration` in `internal/controlplane/api/my_invitations_integration_test.go` (tag `integration`), four cases:

| case | expectation |
|---|---|
| one pending invitation to the caller's address | listed once, with `org_slug` and `role` |
| an invitation to another address | not listed |
| an expired or revoked invitation | not listed |
| accepting one twice | second call → 409 `invitation_not_pending` |

Accepting someone else's invitation by id → 404 (never 403: the id must not confirm existence).

- [ ] **Step 2: Run it and watch it fail**

Run: `go test -tags=integration ./internal/controlplane/api/ -run TestMyInvitationsIntegration`
Expected: FAIL (no such route).

- [ ] **Step 3: Add the query, the service method and the two endpoints**

`ListPendingInvitationsForEmail :many` joins `organizations`, filters `accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND lower(email) = @email` and orders by `created_at DESC`. Acceptance reuses the existing `orgs.InvitationService` accept path (the same membership and authz writes as the token route), looked up by id with the caller's verified address as the guard. Run `task gen:sqlc` and `task gen:openapi`.

- [ ] **Step 4: Run the test and the package**

Run: `go test -tags=integration ./internal/controlplane/api/ -run TestMyInvitationsIntegration && task openapi:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal api/openapi apps/ui/src/lib/identity.ts
git commit -m "feat(orgs): list and accept the invitations waiting for the signed-in user"
```

---

### Task 3: Onboarding state shrinks to `welcome | done`

**Files:**
- Modify: `internal/identity/users/users.go` (`OnboardingPath`, `OnboardingStepAbout` → `OnboardingStepWelcome`), `internal/identity/onboarding.go` (step pattern docs), `apps/ui/src/lib/onboarding.ts`, `apps/ui/src/lib/landing.ts` (`onboardingPath`)
- Test: `apps/ui/src/lib/onboarding.test.ts`, `apps/ui/src/lib/landing.test.ts`, `internal/identity/users/users_test.go`

**Interfaces:**
- Consumes: Task 1's package.
- Produces: `users.OnboardingStepWelcome = "welcome"`, `users.OnboardingPath = "/onboarding/welcome"`; TS `onboardingDecision(ctx: UserContext): OnboardingDecision` (no `page` argument) and `onboardingPath(): "/onboarding/welcome"`; `stageOf` and the `OnboardingAllowed.step/reached` fields are gone.

- [ ] **Step 1: Rewrite the failing tests first** in `apps/ui/src/lib/onboarding.test.ts`

```ts
it("sends a user who has finished onboarding to their landing page", () => {
  expect(onboardingDecision(ctxWith({ completed: true, step: "done" }))).toEqual({ kind: "redirect", location: "/project/my-api/traffic" });
});
it("shows Welcome to anyone who has not", () => {
  expect(onboardingDecision(ctxWith({ completed: false, step: "welcome" }))).toEqual({ kind: "show" });
});
it("shows Welcome to a finished user with nothing to open", () => {
  expect(onboardingDecision(ctxWith({ completed: true, step: "done" }, { orgs: [] }))).toEqual({ kind: "show" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/ui && npx vitest run src/lib/onboarding.test.ts`
Expected: FAIL on the one-argument call and the `{kind:"show"}` shape.

- [ ] **Step 3: Simplify `onboardingDecision`, delete `stageOf` and `STAGES`, and point `onboardingPath` at Welcome**

- [ ] **Step 4: Run the UI unit suite**

Run: `cd apps/ui && npx vitest run`
Expected: PASS; fix every call site the type error names (`lib/auth/onboarding.ts`, the old route pages still compile until Task 5 deletes them).

- [ ] **Step 5: Commit**

```bash
git add internal apps/ui/src/lib
git commit -m "refactor(web): onboarding is one step, not nine"
```

---

### Task 4: The Welcome screen

**Files:**
- Create: `apps/ui/src/app/(auth)/onboarding/welcome/page.tsx`, `apps/ui/src/app/(auth)/onboarding/welcome/actions.ts`, `apps/ui/src/components/onboarding/welcome.tsx`, `apps/ui/src/components/onboarding/welcome.css`, `apps/ui/src/lib/welcome.ts`
- Test: `apps/ui/src/lib/welcome.test.ts`, `apps/ui/e2e-fake/welcome.spec.ts`

**Interfaces:**
- Consumes: Task 2's `listMyInvitations`/`acceptMyInvitation`, the existing `listJoinableOrgs`, `createOrg`, `createProject`, `joinOrg`; Task 3's `onboardingDecision`.
- Produces: `FIRST_PROJECT = { name: "my-api", slug: "my-api", environments: ["production"] }` and `suggestedOrgName(fullName: string): string` in `lib/welcome.ts`; `landingAfterJoin(org: Org): string` in `lib/landing.ts` — the organization's first project's Traffic page, or `/org/<slug>` when it has none; Server Actions `saveName(name: string): Promise<ActionResult>`, `joinOrganization(slug: string): Promise<JoinResult>`, `acceptInvitation(id: string): Promise<JoinResult>`, `createOrganization(name: string, slug: string): Promise<CreateResult>` where `type JoinResult = { ok: true; href: string } | { ok: false; error: string }` and `CreateResult` adds `{ ok: true; href: string; projectFailed?: boolean }`.

**Deviation from the spec, deliberate:** item 17 also mints an ingest key with the first project. The key is minted by the first-run guide in plan B2 instead, when the snippet that needs it is first shown — the raw value is shown once, and carrying it from Welcome to another page would mean stashing a secret in between. The user-visible promise ("the snippet has the key filled in") is unchanged.

- [ ] **Step 1: Write the failing unit tests** in `apps/ui/src/lib/welcome.test.ts`

```ts
it("suggests an organization name from the first name", () => {
  expect(suggestedOrgName("Ada Lovelace")).toBe("Ada's org");
  expect(suggestedOrgName("  ada  ")).toBe("Ada's org");
  expect(suggestedOrgName("")).toBe("");
  expect(suggestedOrgName("Alexis")).toBe("Alexis' org");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/ui && npx vitest run src/lib/welcome.test.ts`
Expected: FAIL, `suggestedOrgName is not a function`.

- [ ] **Step 3: Write the failing test for the landing helper** in `apps/ui/src/lib/landing.test.ts`

```ts
it("opens the joined organization's first project", () => {
  expect(landingAfterJoin(orgWith(["payments", "shop"]))).toBe("/project/payments/traffic");
});
it("opens the organization itself when it has no project", () => {
  expect(landingAfterJoin(orgWith([]))).toBe("/org/acme");
});
```

Run `cd apps/ui && npx vitest run src/lib/landing.test.ts` and watch it fail with `landingAfterJoin is not a function`.

- [ ] **Step 4: Implement `lib/welcome.ts` and `landingAfterJoin`, then the screen and its actions**

The screen renders: a "Full name" field prefilled from `ctx.user.name`; a list of join cards (invitations first, each with its role, then verified-domain matches with member and project counts); and "Create a new organization" with the name prefilled from `suggestedOrgName` and the live slug check `lib/org-slug.ts` already provides. No step bar, no Back link.

`createOrganization` calls `createOrg`, then `createProject(slug, FIRST_PROJECT…)`, then saves `{step:"done"}`. **A failed project creation is not a failed sign-up:** it returns `{ok:true, href:"/org/<slug>", projectFailed:true}` and onboarding still completes, so the user lands on the organization page whose empty state offers "Create your first project" (Phase A). A successful one returns the project's Traffic page.

- [ ] **Step 5: Run the unit tests**

Run: `cd apps/ui && npx vitest run src/lib/welcome.test.ts src/lib/landing.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Write the failing browser spec** `apps/ui/e2e-fake/welcome.spec.ts` against the fake identity, four cases:

| case | expectation |
|---|---|
| no organizations | only "Create a new organization", name prefilled "Ada's org" |
| one invitation | a card naming the organization and role; accepting lands on its project |
| a verified-domain match | a join card; joining lands on that organization's first project |
| create | lands on `/project/my-api/traffic`, and `/onboarding/welcome` afterwards redirects there |

Add the Review Focus case: the fake's `POST /orgs/{org}/projects` answering 500 lands the user on `/org/<slug>` with onboarding complete.

- [ ] **Step 7: Run it, watch it fail, extend `e2e-fake/fake-identity.ts` with the invitation routes, then make it pass**

Run: `cd apps/ui && npx playwright test -c playwright.fake.config.ts e2e-fake/welcome.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/ui
git commit -m "feat(web): one Welcome screen for name and organization"
```

---

### Task 5: Land in the project, and delete the old flow

**Files:**
- Delete: `apps/ui/src/app/(auth)/onboarding/{about,join,create,project,instrument,install,waiting,first-data,invite}/`, `apps/ui/src/components/onboarding/{about,join-org,create-org,create-project,instrument,install,waiting,first-data,invite,invite-team,progress}.tsx` and their CSS, `apps/ui/src/lib/onboarding-invite.ts`
- **Keep:** `components/onboarding/setup-reminder.tsx` — the Traffic, Explore and `[view]` project pages render `<SetupReminder>`; plan B2 replaces it with the first-run guide. Deleting it here breaks three product pages.
- Modify: `apps/ui/src/lib/landing.ts`, `apps/ui/src/lib/auth/onboarding.ts`, `apps/ui/src/app/(auth)/onboarding/layout.tsx`, `apps/ui/src/app/(auth)/onboarding/actions.ts`
- Test: `apps/ui/e2e-fake/onboarding.spec.ts` (rewritten against Welcome), `apps/ui/e2e/onboarding.spec.ts`, `apps/ui/src/lib/landing.test.ts`

**Interfaces:**
- Consumes: Task 4's Welcome route, its actions and `landingAfterJoin`.
- Produces: nothing later tasks consume; this task removes.

- [ ] **Step 1: Delete the nine routes and their components**

Delete, do not adapt: the step bar (`progress.tsx`), the invite step and `lib/onboarding-invite.ts`, and the `install`/`waiting`/`first-data` screens, whose job moves to the Traffic first-run guide in plan B2. `onboarding/layout.tsx` keeps the two-column auth frame only.

- [ ] **Step 2: Prove nothing dangles**

Run: `cd apps/ui && npx tsc --noEmit && npx vitest run`
Expected: PASS, no unresolved imports.

- [ ] **Step 3: Rewrite the onboarding browser specs against Welcome**

`e2e-fake/onboarding.spec.ts` keeps its sign-up → onboarding → app cases and drops every step-bar and per-step assertion; `e2e/onboarding.spec.ts` follows the same path against the real backend. Add the Review Focus case: a user who already belongs to an organization sees it as a join card and no second organization is created.

- [ ] **Step 4: Run the browser suites**

Run: `cd apps/ui && npx playwright test -c playwright.fake.config.ts e2e-fake/onboarding.spec.ts e2e-fake/welcome.spec.ts e2e-fake/create-org-project.spec.ts`
Expected: PASS.

- [ ] **Step 5: Update the docs and commit**

`docs/architecture/identity.md` (the onboarding row and the state shape), `apps/docs` onboarding pages, `apps/docs/self-host/first-admin.mdx`.

```bash
git add apps docs
git commit -m "feat(web): land in the project, and remove the nine-step onboarding"
```

---

### Task 6: "Last time you signed in as …" and passkey first

Spec item 15: sign-in and sign-up share one layout; sign-in puts the passkey button at the top and names the last method used.

**Files:**
- Create: `apps/ui/src/lib/last-signin.ts`, `apps/ui/src/lib/last-signin.test.ts`
- Modify: `apps/ui/src/components/onboarding/sign-in.tsx`, `apps/ui/src/components/onboarding/sign-up.tsx`
- Test: `apps/ui/e2e-fake/sign-in-hint.spec.ts`

**Interfaces:**
- Produces: `rememberSignIn(method: SignInMethod, email: string): void` and `lastSignIn(): { method: SignInMethod; email: string } | null` over `localStorage` (`SignInMethod = "email" | "google" | "github" | "sso" | "passkey"`), both safe when storage throws.

- [ ] **Step 1: Write the failing unit test** in `apps/ui/src/lib/last-signin.test.ts`: a round trip returns the method and address; a blocked `localStorage` (a throwing stub) returns `null` rather than raising; a stored value from an unknown method is ignored.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/ui && npx vitest run src/lib/last-signin.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the helpers, record on every successful sign-in, and show the line**

Sign-in renders "Last time you signed in as **<email>** with <method>" above the buttons and orders passkey first; sign-up keeps the same stacked layout without the line. Nothing is recorded until a sign-in succeeds, and the line never blocks a different method.

- [ ] **Step 4: Write and run the browser spec** `e2e-fake/sign-in-hint.spec.ts`: after signing in with GitHub, returning to `/sign-in` shows the line naming GitHub; a fresh browser context shows no line.

Run: `cd apps/ui && npx playwright test -c playwright.fake.config.ts e2e-fake/sign-in-hint.spec.ts e2e-fake/auth-a11y.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui
git commit -m "feat(web): sign-in remembers how you got in last time"
```

---

## The rest of Phase B (separate plans)

Each produces working software on its own and is planned when its turn comes:

- **B2 — first-run guide and empty states** (items 18, 19, 21): the numbered guide on the Traffic page with the framework control, the masked ingest key minted on first view, the "What you'll see" example panel, the live "Listening for requests…" chip, the empty states on Endpoints, Consumers, Explore and Performance, and the top-bar "Connect API" button. The largest of the four.
- **B3 — Quick start and the passkey offer** (items 20, 22): the five-item popover with its "N left" badge, and the one-time passkey offer after a first sign-in.
- **B4 — demo project** (item 24, cuttable): the shared read-only project, its traffic generator and the "viewing demo data" banner.
- **Carried from Phase A:** honouring "keep me signed in" for the emailed magic link (the choice must travel with the token), and DNS TXT domain verification. Both are backend-shaped and independent of the four above.
