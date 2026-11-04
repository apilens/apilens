// Account settings → Sessions (#343) against the fake identity (e2e-fake/fake-identity.ts). Every
// fake sign-in has three sessions: this browser ("Chrome on macOS") and two seeded devices.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";

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

const rows = (page: Page) => page.getByRole("table").locator("tbody tr");

test("lists sessions with the current one pinned first", async ({ page }) => {
  await signIn(page, "/settings/sessions");
  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
  await expect(rows(page).locator("th")).toHaveText([/Chrome on macOS\s*This device/, /Safari on iOS/, /Firefox on Windows/]);
  await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
  await expect(rows(page).first()).toContainText("203.0.113.7");
  await expect(rows(page).first()).toContainText("Active now");
  await expect(rows(page).nth(1)).toContainText("Unknown");
  await expect(rows(page).nth(1)).toContainText("Passkey + Authenticator app");
  await expect(rows(page).nth(2)).toContainText("3 days ago");
});

test("revokes another session", async ({ page }) => {
  await signIn(page, "/settings/sessions");
  await page.getByRole("button", { name: "Revoke Safari on iOS" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out Safari on iOS.");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("table").getByText("Safari on iOS")).toHaveCount(0);
});

test("signs out every other session", async ({ page }) => {
  await signIn(page, "/settings/sessions");
  const button = page.getByRole("button", { name: "Sign out other sessions" });
  await button.click();
  await expect(page.getByRole("status")).toHaveText("Signed out 2 other sessions.");
  await expect(rows(page)).toHaveCount(1);
  await expect(button).toBeDisabled();
  await expect(page.getByText("This is the only device signed in to your account.")).toBeVisible();
});

test("revoking the current session signs this browser out", async ({ page }) => {
  await signIn(page, "/settings/sessions");
  await page.getByRole("button", { name: /^Revoke Chrome on macOS \(this device\)/ }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("reason") === "signed_out");
  await page.goto("/settings/sessions");
  await page.waitForURL((url) => url.pathname === "/sign-in");
});

// Visual check (light/dark at 1440 and 390): `SESSIONS_SHOTS=<dir> pnpm test:e2e:fake sessions`.
test("screenshots", async ({ page }) => {
  const dir = process.env.SESSIONS_SHOTS;
  test.skip(!dir, "set SESSIONS_SHOTS to a directory to capture screenshots");
  await signIn(page, "/settings/sessions");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
      await page.screenshot({ path: `${dir}/sessions-${theme}-${width}.png`, fullPage: true });
    }
  }
});
