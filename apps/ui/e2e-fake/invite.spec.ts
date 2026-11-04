// The invitation landing (#337) against the fake identity (e2e-fake/fake-identity.ts):
// `inv_globex` invites you@example.com (the fake user) to Globex, whose one project is
// `storefront`; `inv_other` invites another @example.com address; `inv_expired` has expired.
// Both ways in are covered: a new account (sign up) and a device that remembers an account
// (sign in). Invited users skip the organization and project steps after "about".
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const INVITE = "/invite/inv_globex";
const ABOUT = "What should you see first?";

function githubButton(page: Page) {
  return page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ });
}

const accept = (page: Page) => page.getByRole("link", { name: "Accept invitation" });
const acceptButton = (page: Page) => page.getByRole("button", { name: "Accept invitation" });

/** Signs in through the fake handoff and lands on `next`. */
async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** After accepting: about (Account step), then straight into Globex's project. */
async function finishAsInvited(page: Page) {
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Account");
  await page.getByRole("button", { name: "Continue to Globex" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/storefront/"));

  // Onboarding is finished: its pages send the user to their project now.
  await page.goto("/onboarding/join");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
}

test("new account: invitation → sign up → accept → about → the organization's project", async ({ page }) => {
  await page.goto(INVITE);
  await expect(page.getByRole("heading", { name: "Join Globex on APILens" })).toBeVisible();
  await expect(page.getByText("Olive Owner invited you to join Globex as a Member.")).toBeVisible();
  await expect(page.getByTestId("invite-email")).toHaveText("y***@example.com");
  await expect(page.getByText("Expires in 7 days")).toBeVisible();
  await expect(accept(page)).toHaveAttribute("href", `/sign-up?next=${encodeURIComponent(INVITE)}`);

  await accept(page).click();
  await page.waitForURL((url) => url.pathname === "/sign-up" && url.searchParams.get("next") === INVITE);
  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();

  // Back on the invitation, signed in: accepting now joins.
  await page.waitForURL((url) => url.pathname === INVITE);
  await expect(page.getByText("Signed in as you@example.com")).toBeVisible();
  await acceptButton(page).click();
  await finishAsInvited(page);
});

test("remembered account: invitation → sign in → accept → about → the organization's project", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("apilens.remembered-account", JSON.stringify({ email: "you@example.com", at: Date.now() }));
  });
  await page.goto(INVITE);
  await expect(accept(page)).toHaveAttribute("href", `/sign-in?next=${encodeURIComponent(INVITE)}`);
  await accept(page).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === INVITE);

  await signIn(page, INVITE);
  await acceptButton(page).click();
  await finishAsInvited(page);
});

test("signed in as someone else: asks to sign in with the invited address", async ({ page }) => {
  await signIn(page, "/invite/inv_other");
  await expect(page.getByTestId("invite-email")).toHaveText("s***@example.com");
  await acceptButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "This invitation is for" })).toContainText("This invitation is for s***@example.com, but you’re signed in as you@example.com.");

  await page.getByRole("button", { name: "Sign in with s***@example.com" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === "/invite/inv_other");
});

test("expired and unknown invitations explain themselves", async ({ page }) => {
  await page.goto("/invite/inv_expired");
  await expect(page.getByRole("heading", { name: "Invitation expired" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Accept invitation" })).toHaveCount(0);

  await page.goto("/invite/nope");
  await expect(page.getByRole("heading", { name: "Invitation not found" })).toBeVisible();
});
