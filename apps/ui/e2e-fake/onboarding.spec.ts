// Onboarding guard (#326) against the fake identity: signed-out visitors go to sign-up, a step
// ahead of the saved one goes back to it, and browser back/forward still works. The fake user's
// context has onboarding open at no saved step (the first one, `about`).
import { type Page, expect, test } from "@playwright/test";

function githubButton(page: Page) {
  return page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ });
}

const ABOUT = "What should you see first?";

test("signed out → sign-up, then onboarding starts at the saved step", async ({ page }) => {
  await page.goto("/onboarding/create");
  await page.waitForURL((url) => url.pathname === "/sign-up" && url.searchParams.get("next") === "/onboarding/about");

  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Account");

  // Ahead of the saved step: back to it.
  await page.goto("/onboarding/create");
  await page.waitForURL((url) => url.pathname === "/onboarding/about");

  // Back/forward between onboarding and another page still works.
  await page.goto("/acme/requests");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();
  await page.goForward();
  await page.waitForURL((url) => url.pathname === "/acme/requests");
});
