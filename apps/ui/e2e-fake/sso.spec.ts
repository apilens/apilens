// "Continue with SSO" (#323) end to end against a fake identity and a fake OIDC identity provider
// (e2e-fake/fake-identity.ts). acme.example.com enforces SSO, beta.example.com offers it without
// enforcing, other domains have none. Only @example.com addresses; nothing sends mail.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SESSION_COOKIE = "apilens_session";

const ssoLink = (page: Page, org?: string) =>
  page.getByRole("link", { name: org ? `Continue with ${org} SSO` : "Continue with SSO" });

/** Counts the browser's calls to the email-code Route Handler. */
function countEmailStarts(page: Page) {
  const calls: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/auth/email/start") calls.push(req.url());
  });
  return calls;
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
}

test("sign-in: an enforced domain replaces the email code with the org's SSO and signs in", async ({ page }) => {
  const emailStarts = countEmailStarts(page);
  await page.goto("/sign-in?next=%2Facme%2Frequests");
  await expect(page.getByRole("button", { name: "Email code" })).toBeVisible();
  await page.getByLabel("Work email").fill("ada@acme.example.com");

  const link = ssoLink(page, "Acme");
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/ah-btn--primary/);
  await expect(page.getByRole("button", { name: "Email code" })).toHaveCount(0);
  // The generic SSO button gives way to the org's own.
  await expect(page.getByRole("button", { name: "SSO", exact: true })).toHaveCount(0);

  const href = new URL((await link.getAttribute("href")) ?? "");
  expect(href.origin + href.pathname).toBe(`${IDENTITY}/api/v1/auth/sso/acme/start`);
  expect(Object.fromEntries(href.searchParams)).toEqual({
    next: "/acme/requests",
    remember: "true",
    login_hint: "ada@acme.example.com",
  });

  await link.click();
  await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toBeVisible();
  await expect(page.locator("#login-hint")).toHaveText("ada@acme.example.com");
  await page.getByRole("link", { name: "Sign in" }).click();

  await page.waitForURL((url) => url.pathname === "/acme/requests");
  expect((await sessionCookie(page))?.httpOnly).toBe(true);
  expect(emailStarts).toHaveLength(0);
});

test("sign-in: Enter on an enforced domain goes to the IdP, never sending a code", async ({ page }) => {
  const emailStarts = countEmailStarts(page);
  await page.goto("/sign-in");
  const field = page.getByLabel("Work email");
  await field.fill("ada@acme.example.com");
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toBeVisible();
  expect(emailStarts).toHaveLength(0);
});

test("sign-in: SSO that is not enforced is a secondary button next to the email code", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("ada@beta.example.com");
  const link = ssoLink(page, "Beta");
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/ah-btn--secondary/);
  await expect(page.getByRole("button", { name: "Email code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with a passkey" })).toHaveClass(/ah-btn--primary/);

  // A domain without SSO takes it away again.
  await page.getByLabel("Work email").fill("ada@example.com");
  await expect(ssoLink(page, "Beta")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "SSO", exact: true })).toBeVisible();
});

test("sign-in: a failed lookup still never sends a code; sso_required shows the banner and the SSO", async ({ page }) => {
  await page.route("**/api/auth/sso/lookup", (route) => route.abort());
  await page.goto("/sign-in?next=%2Facme%2Fendpoints");
  await page.getByLabel("Work email").fill("ada@acme.example.com");
  await page.getByRole("button", { name: "Email code" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Your organization requires single sign-on." })).toBeVisible();
  const link = ssoLink(page);
  await expect(link).toBeVisible();
  const href = new URL((await link.getAttribute("href")) ?? "");
  expect(href.origin + href.pathname).toBe(`${IDENTITY}/api/v1/auth/sso/acme/start`);
  expect(href.searchParams.get("next")).toBe("/acme/endpoints");
  expect(href.searchParams.get("login_hint")).toBe("ada@acme.example.com");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("sign-in: ?error=sso_required shows the banner", async ({ page }) => {
  await page.goto("/sign-in?error=sso_required");
  await expect(page.getByRole("status")).toContainText("Your organization requires single sign-on.");
});

test("sign-in: the generic SSO button asks for an email, then explains a domain without SSO", async ({ page }) => {
  // The fake has no passkeys: keep the email field's passkey autofill pending so its error stays out.
  await page.route("**/api/auth/passkeys/login/options", () => {});
  await page.goto("/sign-in");
  const generic = page.getByRole("button", { name: "SSO", exact: true });
  await generic.click();
  await expect(page.locator("p.ob-err[role=alert]")).toHaveText("Enter your work email to continue with SSO.");

  await page.route("**/api/auth/sso/lookup", (route) =>
    route.fulfill({ json: { ok: true, sso: false, enforced: false } }),
  );
  await page.getByLabel("Work email").fill("ada@example.com");
  await generic.click();
  await expect(page.locator("p.ob-err[role=alert]")).toContainText("Single sign-on isn’t set up for that email’s domain.");
});

test("sign-up: an enforced domain replaces Continue with the org's SSO and sends no code", async ({ page }) => {
  const emailStarts = countEmailStarts(page);
  await page.goto("/sign-up");
  await page.getByLabel("Work email").fill("ada@acme.example.com");
  const link = ssoLink(page, "Acme");
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/ah-btn--primary/);
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(page.getByText("Acme signs in with single sign-on.")).toBeVisible();

  await link.click();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  expect(await sessionCookie(page)).toBeTruthy();
  expect(emailStarts).toHaveLength(0);
});

test("sign-up: SSO that is not enforced is offered under Continue", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Work email").fill("ada@beta.example.com");
  await expect(ssoLink(page, "Beta")).toHaveClass(/ah-btn--secondary/);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});

test("cancelling at the IdP lands on /sign-in with the error, signed out", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("ada@acme.example.com");
  await ssoLink(page, "Acme").click();
  await page.getByRole("link", { name: "Cancel" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "oauth_denied");
  expect(await sessionCookie(page)).toBeUndefined();
});
