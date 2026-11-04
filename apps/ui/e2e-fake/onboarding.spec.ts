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

// #328: Continue on "What should you see first?" saves the pick as the home preference, so it is
// still selected after a refresh.
test("the home screen pick is saved and stays selected after a refresh", async ({ page }) => {
  await page.goto("/sign-in");
  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  const picks = page.getByRole("radiogroup", { name: "Home screen" });
  await expect(picks.getByRole("radio", { name: /^Slow or failing endpoints/ })).toHaveAttribute("aria-checked", "true");

  await picks.getByRole("radio", { name: /^Exceptions/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/join");

  await page.goto("/onboarding/about");
  await page.reload();
  await expect(picks.getByRole("radio", { name: /^Exceptions/ })).toHaveAttribute("aria-checked", "true");
  await expect(picks.getByRole("radio", { name: /^Slow or failing endpoints/ })).toHaveAttribute("aria-checked", "false");
});

// #327: every Continue saves the step and answers (`PATCH /users/me/onboarding`), so a refresh
// resumes on the saved step with what was entered; a failed save shows a toast.
test("Continue saves progress, so a refresh resumes with the answers", async ({ page }) => {
  await page.goto("/sign-in");
  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();

  // About → join: saved before the guard is asked, so the page stays after a refresh.
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/join");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Join your team on APILens" })).toBeVisible();
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Organization");
  expect(new URL(page.url()).pathname).toBe("/onboarding/join");

  // A failed save keeps the screen and says so.
  await page.getByRole("link", { name: "Create a separate organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill("Example Co");
  const address = page.getByRole("textbox", { name: /^Address/ });
  await address.fill("unavailable");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("status").filter({ hasText: "couldn’t reach APILens to save your progress" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/onboarding/create");

  // The saved address comes back after leaving the screen and refreshing it.
  await address.fill("example-co");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname !== "/onboarding/create");
  await page.goto("/onboarding/create");
  await page.reload();
  await expect(page.getByRole("textbox", { name: /^Address/ })).toHaveValue("example-co");
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Organization");

  // Passing an earlier screen again goes straight on (the save follows) and still resumes there.
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/join");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Join your team on APILens" })).toBeVisible();
});
