// Welcome, the one onboarding screen, against the fake identity (e2e-fake/fake-identity.ts):
// the name, the organizations on offer (invitations first, then verified-domain matches) and
// creating one with its first project. Every sign-in here is seeded `no_orgs`, as a first
// sign-in really is. Nothing sends mail.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PAGE = "/onboarding/welcome";

// The fake keeps one profile and these tests rename it, so they run one after another.
test.describe.configure({ mode: "serial" });

async function fakeProfile(name: string) {
  await fetch(`${IDENTITY}/__fake/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** Signs a brand-new fake user in (no organization) with what Welcome should offer them. */
async function signIn(page: Page, seeds: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE, no_orgs: true, ...seeds }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  // `next dev` compiles the route on its first visit, which can outlast the default timeout.
  await expect(page.getByRole("heading", { name: "Welcome to APILens" })).toBeVisible({ timeout: 20_000 });
}

const cards = (page: Page) => page.getByTestId("welcome-org");
/** The screen's error notice (the route announcer is an `alert` too). */
const notice = (page: Page) => page.locator(".ob-notice--error");

/** What someone else does to an invitation while Welcome is open. */
async function elsewhere(id: string, state: "accepted" | "revoked") {
  await fetch(`${IDENTITY}/__fake/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, state }),
  });
}

const GLOBEX_INVITE = "11111111-1111-4111-8111-111111111111";
const HOOLI_INVITE = "22222222-2222-4222-8222-222222222222";
const STALE = "That invitation was already accepted or revoked. The list has been refreshed.";

test.beforeEach(() => fakeProfile("Ada Lovelace"));
test.afterAll(() => fakeProfile("Fake User"));

test("without an organization it offers only creating one, named after the user", async ({ page }) => {
  await signIn(page);

  // No step bar, no Back: Welcome is the only screen.
  await expect(page.locator(".ob-steps")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back" })).toHaveCount(0);

  await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
  await expect(cards(page)).toHaveCount(0);
  const create = page.getByTestId("welcome-create");
  await expect(create).toContainText("Create a new organization");
  await expect(create).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Organization name")).toHaveValue("Ada's org");
  await expect(page.getByRole("button", { name: "Create organization" })).toBeEnabled();

  // It follows the full name until it is edited: an email sign-up starts without one.
  await page.getByLabel("Full name").fill("Grace Hopper");
  await expect(page.getByLabel("Organization name")).toHaveValue("Grace's org");
  await expect(page.getByRole("textbox", { name: /^Address/ })).toHaveValue("grace-s-org");
});

// A name `slugify` leaves nothing of (CJK, Arabic, Cyrillic, emoji) suggests no organization name
// at all, since its address would come from the possessive alone and addresses are immutable. The
// fields then say what to type, instead of a disabled button with nothing said.
test("a name that gives no address suggests none, and says what to type", async ({ page }) => {
  await fakeProfile("张伟");
  await signIn(page);

  await expect(page.getByLabel("Full name")).toHaveValue("张伟");
  const orgName = page.getByLabel("Organization name");
  const address = page.getByRole("textbox", { name: /^Address/ });
  const create = page.getByRole("button", { name: "Create organization" });
  await expect(orgName).toHaveValue("");
  await expect(create).toBeDisabled();
  await expect(page.getByText("Enter a name of at least two characters.")).toBeVisible();
  await expect(orgName).toHaveAttribute("aria-invalid", "true");

  // Their own organization's name, which `slugify` also leaves nothing of: the address is next.
  await orgName.fill("张伟科技");
  await expect(page.getByText("Enter a name of at least two characters.")).toHaveCount(0);
  await expect(address).toHaveValue("");
  await expect(create).toBeDisabled();
  await expect(page.getByText(/doesn’t give an address/)).toBeVisible();
  await expect(address).toHaveAttribute("aria-invalid", "true");

  // Typing one is all it takes. (Creating it here would take the one global `my-api` address the
  // next test needs — project addresses are unique per deployment, not per organization.)
  await address.fill("zhang-wei");
  await expect(page.locator(".ob-in .r")).toContainText("Available");
  await expect(page.getByText(/doesn’t give an address/)).toHaveCount(0);
  await expect(address).toHaveAttribute("aria-invalid", "false");
  await expect(create).toBeEnabled();
});

test("an invitation is offered with its role, and accepting it opens its project", async ({ page }) => {
  await signIn(page, {
    invitations: [{ org_slug: "globex", org_name: "Globex", role: "admin", invited_by_name: "Olive Owner", projects: ["storefront"] }],
  });

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Join Globex");
  await expect(cards(page)).toContainText("Invited by Olive Owner · Admin");
  await expect(cards(page)).toHaveAttribute("aria-checked", "true");
  // Picking the invitation puts the creating fields away.
  await expect(page.getByLabel("Organization name")).toHaveCount(0);

  await page.getByRole("button", { name: "Join Globex" }).click();
  await page.waitForURL((url) => url.pathname === "/project/storefront/traffic");
});

test("a verified-domain match is offered, and joining it opens its first project", async ({ page }) => {
  await signIn(page, {
    joinable: [{ slug: "initech", name: "Initech", member_count: 4, member_initials: ["PG", "BL"], projects: ["payments", "shop-2"] }],
  });

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Join Initech");
  await expect(cards(page)).toContainText("4 members · 2 projects");
  await expect(cards(page)).toContainText("Open to verified @example.com emails");

  await page.getByRole("button", { name: "Join Initech" }).click();
  await page.waitForURL((url) => url.pathname === "/project/payments/traffic");
});

test("creating an organization creates my-api with it and lands in the project", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Organization name").fill("Lovelace Labs");
  await expect(page.getByRole("textbox", { name: /^Address/ })).toHaveValue("lovelace-labs");
  await expect(page.locator(".ob-in .r")).toContainText("Available");

  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/project/my-api/traffic");

  // Onboarding is finished: Welcome now sends the user back to their project.
  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/project/my-api/traffic");
});

// Project addresses are unique per deployment, so the organization above took the only `my-api`
// (these tests are serial, in order, against one fake). The next one still gets a first project,
// at the address the API offers, and lands in it — without the retry it would get none.
test("the next organization's first project takes the address the API offers", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Organization name").fill("Second Labs");
  await expect(page.locator(".ob-in .r")).toContainText("Available");

  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/project/my-api-api/traffic");

  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/project/my-api-api/traffic");
});

// Review Focus: a failed first project is not a failed sign-up. Neither `my-api` nor the address
// offered instead is free here, so the organization is all the user gets — and that is enough.
test("a first project with no free address still completes onboarding", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Organization name").fill("Every Address Taken");
  await expect(page.getByRole("textbox", { name: /^Address/ })).toHaveValue("every-address-taken");

  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/org/every-address-taken");
  await expect(page.getByRole("link", { name: "Create your first project" })).toBeVisible();

  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/org/every-address-taken");
});

// A card the screen is still showing can be stale: the invitation may have been accepted,
// revoked or expired elsewhere. Accepting it then answers 409 `invitation_not_pending` or 404,
// and the screen must say so and reload what is on offer.
test("an invitation accepted elsewhere says so, and the reloaded card continues into it", async ({ page }) => {
  await signIn(page, {
    invitations: [{ id: GLOBEX_INVITE, org_slug: "globex", org_name: "Globex", role: "member", projects: ["storefront"] }],
  });
  await expect(cards(page)).toContainText("Join Globex");

  await elsewhere(GLOBEX_INVITE, "accepted");
  await page.getByRole("button", { name: "Join Globex" }).click();
  await expect(notice(page)).toHaveText(STALE);

  // Reloaded: the user is a member of Globex now, so the card offers to continue into it.
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("You’re already a member");
  await expect(cards(page)).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue to Globex" }).click();
  await page.waitForURL((url) => url.pathname === "/project/storefront/traffic");
});

test("a revoked invitation leaves the next one picked, not the create form", async ({ page }) => {
  await signIn(page, {
    invitations: [
      { id: GLOBEX_INVITE, org_slug: "globex", org_name: "Globex", projects: ["storefront"] },
      { id: HOOLI_INVITE, org_slug: "hooli", org_name: "Hooli", projects: ["nucleus"] },
    ],
  });
  await expect(cards(page)).toHaveCount(2);

  await elsewhere(GLOBEX_INVITE, "revoked");
  await page.getByRole("button", { name: "Join Globex" }).click();
  await expect(notice(page)).toHaveText(STALE);

  // Globex is gone from the list; the invitation left is the one picked, and creating is not.
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Join Hooli");
  await expect(cards(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("welcome-create")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join Hooli" })).toBeEnabled();
});

// Review Focus: a failed first project is not a failed sign-up. The organization exists and
// onboarding is complete, so the user lands on it and its empty state offers the first project.
test("a failed first project still completes onboarding, on the organization page", async ({ page }) => {
  await signIn(page);
  // The fake answers 500 to `POST /orgs/project-fails/projects`.
  await page.getByLabel("Organization name").fill("Project Fails");
  await expect(page.getByRole("textbox", { name: /^Address/ })).toHaveValue("project-fails");

  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/org/project-fails");
  await expect(page.getByRole("link", { name: "Create your first project" })).toBeVisible();

  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/org/project-fails");
});
