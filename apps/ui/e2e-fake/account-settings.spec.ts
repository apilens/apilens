// The account section (#339) against the fake identity (e2e-fake/fake-identity.ts): signs in
// through a fake handoff, then checks the section nav, its keyboard navigation and the 404 for
// unknown sections.
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

const sectionNav = (page: Page) => page.getByRole("navigation", { name: "Account settings" });

test("opens Profile at /settings with the Account breadcrumb", async ({ page }) => {
  await signIn(page, "/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/settings");
  await expect(crumbs.getByText("Profile")).toHaveAttribute("aria-current", "page");
  await expect(sectionNav(page).getByRole("link")).toHaveText(["Profile", "Security", "Sessions", "Connected accounts", "Danger zone"]);
  await expect(sectionNav(page).getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
});

test("moves through the sections with the keyboard", async ({ page }) => {
  await signIn(page, "/settings/security");
  const nav = sectionNav(page);
  await expect(nav.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Security" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("link", { name: "Sessions" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(nav.getByRole("link", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("link", { name: "Profile" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(nav.getByRole("link", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(nav.getByRole("link", { name: "Profile" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Security" })).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === "/settings/connected-accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Connected accounts" })).toBeVisible();
});

test("the account menu links to account settings", async ({ page }) => {
  await signIn(page, "/settings/sessions");
  await page.getByRole("button", { name: /^Account menu/ }).click();
  const item = page.getByRole("menuitem", { name: "Account settings" });
  await expect(item).toHaveAttribute("href", "/settings");
  await expect(item).toHaveAttribute("aria-current", "page");
});

test("unknown sections are a 404", async ({ page }) => {
  await signIn(page, "/settings");
  for (const path of ["/settings/billing", "/settings/security/passkeys"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
  }
});

// Visual check (light/dark at 1440 and 390): `ACCOUNT_SHOTS=<dir> pnpm test:e2e:fake account`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ACCOUNT_SHOTS;
  test.skip(!dir, "set ACCOUNT_SHOTS to a directory to capture screenshots");
  await signIn(page, "/settings/security");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
      await page.screenshot({ path: `${dir}/account-${theme}-${width}.png` });
    }
  }
});
