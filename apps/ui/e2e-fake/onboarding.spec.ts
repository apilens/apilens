// Onboarding guard (#326) against the fake identity: signed-out visitors go to sign-up and then
// Welcome, the only onboarding screen, browser back/forward still works, and a user who already
// belongs to an organization is offered it instead of a second one. The fake user's context has
// onboarding open until Welcome finishes it.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const WELCOME = "Welcome to APILens";
const PAGE = "/onboarding/welcome";

/** The redirect-based way in that the page still offers: an SSO domain's own button. */
async function ssoIn(page: Page) {
  await page.getByLabel("Work email").fill("ada@acme.example.com");
  await page.getByRole("link", { name: "Continue with Acme SSO" }).click();
}

/** Signs in through the fake handoff (a user who belongs to acme, onboarding open) and lands on Welcome. */
async function signIn(page: Page) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { name: WELCOME })).toBeVisible({ timeout: 20_000 });
}

async function orgsCreated(): Promise<string[]> {
  const res = await fetch(`${IDENTITY}/__fake/orgs-created`);
  return ((await res.json()) as { orgs: string[] }).orgs;
}

test("signed out → sign-up → Welcome, with no step bar anywhere", async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/sign-up" && url.searchParams.get("next") === PAGE);
  await expect(page.locator(".ob-steps")).toHaveCount(0);

  await ssoIn(page);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { name: WELCOME })).toBeVisible();
  await expect(page.locator(".ob-steps")).toHaveCount(0);

  // Back/forward between onboarding and another page still works.
  await page.goto("/project/acme/requests");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { name: WELCOME })).toBeVisible();
  await page.goForward();
  await page.waitForURL((url) => url.pathname === "/project/acme/requests");
});

// Review Focus: someone who already belongs to an organization (an invitation accepted at its
// link, or a second sign-in) sees it as a card to continue into, not a form for a second one.
test("a user who already belongs to an organization continues into it and no second one is created", async ({ page }) => {
  const before = await orgsCreated();
  await signIn(page);

  const cards = page.getByTestId("welcome-org");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Acme");
  await expect(cards).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("welcome-create")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Organization name")).toHaveCount(0);

  await page.getByRole("button", { name: "Continue to Acme" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/project/"));
  expect(await orgsCreated()).toEqual(before);

  // Onboarding is finished: Welcome now sends the user back to their project.
  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname.startsWith("/project/"));
});

// The nine-step flow is gone: its addresses are no longer pages.
test("the old step addresses are gone", async ({ page }) => {
  await signIn(page);
  for (const step of ["about", "join", "create", "project", "instrument", "install", "waiting", "first-data", "invite"]) {
    const res = await page.goto(`/onboarding/${step}`);
    expect(res?.status(), step).toBe(404);
  }
});
