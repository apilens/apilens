// Google and GitHub sign-in (#317) end to end against a fake identity and a fake OAuth provider
// (e2e-fake/fake-identity.ts): the button navigates to identity's start URL, the provider consent
// page sends the browser back through identity's callback to `/auth/callback?code=…`, and the UI
// server redeems the code and seals the session cookie. Includes open redirects through `next`.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SESSION_COOKIE = "apilens_session";

/** A provider button, found by its visible label. */
function providerButton(page: Page, label: "GitHub" | "Google") {
  return page.locator("a.ah-btn").filter({ hasText: new RegExp(`^${label}$`) });
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

for (const provider of ["GitHub", "Google"] as const) {
  test(`${provider} on /sign-in signs in and lands on next`, async ({ page }) => {
    await page.goto("/sign-in?next=%2Facme%2Frequests");
    const button = providerButton(page, provider);
    const href = new URL((await button.getAttribute("href")) ?? "");
    expect(href.origin + href.pathname).toBe(`${IDENTITY}/api/v1/auth/oauth/${provider.toLowerCase()}/start`);
    expect(Object.fromEntries(href.searchParams)).toEqual({ next: "/acme/requests", intent: "login", remember: "true" });

    await button.click();
    await expect(page.getByRole("heading", { name: `Fake ${provider.toLowerCase()} consent` })).toBeVisible();
    await page.getByRole("link", { name: "Authorize" }).click();

    await page.waitForURL((url) => url.pathname === "/acme/requests");
    const cookie = await sessionCookie(page);
    expect(cookie?.httpOnly).toBe(true);
    expect(page.url()).not.toContain("code=");
  });
}

test("a new user from /sign-up goes to onboarding", async ({ page }) => {
  await page.goto("/sign-up");
  await providerButton(page, "GitHub").click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  expect(await sessionCookie(page)).toBeTruthy();
});

test("declining consent lands on /sign-in with the error, signed out", async ({ page }) => {
  await page.goto("/sign-in");
  await providerButton(page, "Google").click();
  await page.getByRole("link", { name: "Deny" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "oauth_denied");
  expect(await sessionCookie(page)).toBeUndefined();
});

test("?error= on /auth/callback goes back to /sign-in", async ({ page }) => {
  await page.goto("/auth/callback?error=oauth_email_unverified");
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "oauth_email_unverified");
  await expect(page.getByText("That provider account has no verified email.", { exact: false })).toBeVisible();
});

test("a used handoff code cannot sign in twice", async ({ page }) => {
  const code = await handoffCode("/acme/endpoints");
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/acme/endpoints");
  await page.context().clearCookies();
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("error") === "invalid_token");
  expect(await sessionCookie(page)).toBeUndefined();
});

test.describe("open redirects through next", () => {
  for (const next of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/x", "javascript:alert(1)"]) {
    test(`the buttons drop next=${next}`, async ({ page }) => {
      await page.goto(`/sign-in?${new URLSearchParams({ next })}`);
      const href = new URL((await providerButton(page, "GitHub").getAttribute("href")) ?? "");
      expect(href.origin).toBe(IDENTITY);
      expect(href.searchParams.has("next")).toBe(false);
    });

    test(`the callback ignores a handoff next=${next}`, async ({ page }) => {
      const code = await handoffCode(next);
      await page.goto(`/auth/callback?${new URLSearchParams({ code, next })}`);
      // `/` for a signed-in user, which the gate sends on to onboarding: never off this origin.
      expect(new URL(page.url()).host).toBe("localhost:3210");
      expect(await sessionCookie(page)).toBeTruthy();
    });
  }
});
