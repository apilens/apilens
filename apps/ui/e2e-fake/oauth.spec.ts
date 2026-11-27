// Google and GitHub sign-in (#317) end to end against a fake identity and a fake OAuth provider
// (e2e-fake/fake-identity.ts): identity's start URL sends the browser to the provider, the consent
// page sends it back through identity's callback to `/auth/callback?code=…`, and the UI server
// redeems the code and seals the session cookie. Includes open redirects through `next`.
//
// The sign-in and sign-up pages no longer offer these buttons, so each flow starts by navigating to
// identity's start URL directly. What the buttons used to prove about that URL — its shape, and that
// an off-origin `next` is dropped — is pinned in `src/lib/oauth.test.ts`; the round trip below is
// what only a browser can show. The routes still answer, so the flow is still worth guarding.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SESSION_COOKIE = "apilens_session";

/** Identity's start endpoint, the URL the removed buttons pointed at (`oauthStartUrl`'s shape). */
function startUrl(provider: "github" | "google", opts: { next?: string; remember?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (opts.next) q.set("next", opts.next);
  q.set("intent", "login");
  q.set("remember", String(opts.remember ?? true));
  return `${IDENTITY}/api/v1/auth/oauth/${provider}/start?${q}`;
}

/** Goes through the provider's consent page to the UI, as the button used to. */
async function consent(page: Page, provider: "github" | "google", answer: "Authorize" | "Deny", opts: { next?: string; remember?: boolean } = {}) {
  await page.goto(startUrl(provider, opts));
  await expect(page.getByRole("heading", { name: `Fake ${provider} consent` })).toBeVisible();
  await page.getByRole("link", { name: answer }).click();
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
}

/** A handoff code from the fake identity whose bundle carries `next` as given. */
async function handoffCode(next: string): Promise<string> {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next }),
  });
  return ((await res.json()) as { code: string }).code;
}

// Review Focus: the product offers a passkey, SSO and an emailed code. A Google or GitHub button
// reappearing on either page is a regression, not a feature — the stack is asserted present so a
// page that failed to render cannot pass this by having no buttons at all.
for (const path of ["/sign-in", "/sign-up"] as const) {
  test(`${path} offers no Google or GitHub button`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("a.ah-btn, button.ah-btn").filter({ hasText: /Continue with/ }).first()).toBeVisible();
    await expect(page.locator('a[href*="/auth/oauth/"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Google|GitHub/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Google|GitHub/ })).toHaveCount(0);
  });
}

for (const provider of ["github", "google"] as const) {
  test(`${provider} signs in and lands on next`, async ({ page }) => {
    await consent(page, provider, "Authorize", { next: "/project/acme/requests" });

    await page.waitForURL((url) => url.pathname === "/project/acme/requests");
    const cookie = await sessionCookie(page);
    expect(cookie?.httpOnly).toBe(true);
    expect(page.url()).not.toContain("code=");
  });
}

test("remember=false gives a 24-hour session", async ({ page }) => {
  await consent(page, "github", "Authorize", { next: "/project/acme/requests", remember: false });
  await page.waitForURL((url) => url.pathname === "/project/acme/requests");
  const cookie = await sessionCookie(page);
  const left = (cookie?.expires ?? 0) - Date.now() / 1000;
  expect(left).toBeGreaterThan(24 * 3600 - 300);
  expect(left).toBeLessThan(24 * 3600 + 300);
});

test("a new user with no next goes to onboarding", async ({ page }) => {
  await consent(page, "github", "Authorize");
  await page.waitForURL((url) => url.pathname === "/onboarding/welcome");
  expect(await sessionCookie(page)).toBeTruthy();
});

test("declining consent lands on /sign-in with the error, signed out", async ({ page }) => {
  await consent(page, "google", "Deny");
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "oauth_denied");
  expect(await sessionCookie(page)).toBeUndefined();
});

test("?error= on /auth/callback goes back to /sign-in", async ({ page }) => {
  await page.goto("/auth/callback?error=oauth_email_unverified");
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "oauth_email_unverified");
  await expect(page.getByText("That provider account has no verified email.", { exact: false })).toBeVisible();
});

test("a used handoff code cannot sign in twice", async ({ page }) => {
  const code = await handoffCode("/project/acme/endpoints");
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/project/acme/endpoints");
  await page.context().clearCookies();
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "invalid_token");
  expect(await sessionCookie(page)).toBeUndefined();
});

test.describe("open redirects through next", () => {
  for (const next of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/x", "javascript:alert(1)"]) {
    test(`the callback ignores a handoff next=${next}`, async ({ page }) => {
      const code = await handoffCode(next);
      await page.goto(`/auth/callback?${new URLSearchParams({ code, next })}`);
      // `/` for a signed-in user, which the gate sends on to onboarding: never off this origin.
      expect(new URL(page.url()).host).toBe("localhost:3210");
      expect(await sessionCookie(page)).toBeTruthy();
    });
  }
});
