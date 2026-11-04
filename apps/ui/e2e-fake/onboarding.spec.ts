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

// #330: the address is checked as the user types (debounced; a new keystroke aborts the check in
// flight), a taken one offers the API's suggestions, Create calls `POST /orgs` (a slug taken in
// between is reported on the field) and continues to the project step with `org_slug` saved.
test("Name your organization checks the address live and creates the org", async ({ page }) => {
  await page.goto("/sign-in");
  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/join");
  await page.getByRole("link", { name: "Create a separate organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");

  const address = page.getByRole("textbox", { name: /^Address/ });
  const indicator = page.locator(".ob-in .r");
  const create = page.getByRole("button", { name: "Create organization" });
  // The address is shown under the real public host.
  await expect(page.locator(".ob-in .pre")).toHaveText("localhost:3210/");

  // A taken address (from the name) says so and offers suggestions; Create stays disabled.
  await page.getByLabel("Name", { exact: true }).fill("Globex");
  await expect(address).toHaveValue("globex");
  await expect(page.locator("#slug-err")).toContainText("That address is taken.");
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expect(create).toBeDisabled();

  // A suggestion fills the address, which is then available.
  await page.getByRole("button", { name: "globex-hq" }).click();
  await expect(address).toHaveValue("globex-hq");
  await expect(indicator).toHaveText("Available");
  await expect(create).toBeEnabled();

  // Each keystroke aborts the check still in flight: hold every check so a later key lands first.
  const aborted: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/orgs/slug-available")) aborted.push(new URL(r.url()).searchParams.get("slug") ?? "");
  });
  await page.route("**/api/orgs/slug-available*", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  const checked = page.waitForRequest((r) => r.url().includes("slug-available?slug=globex-hqa"));
  await address.press("End");
  await address.press("a");
  await checked;
  await address.press("b");
  await expect.poll(() => aborted).toContain("globex-hqa");
  await page.unroute("**/api/orgs/slug-available*");
  await expect(indicator).toHaveText("Available");

  // Taken between the check and Create: reported on the field, the screen stays.
  await address.fill("race-lost");
  await expect(indicator).toHaveText("Available");
  await create.click();
  await expect(page.locator("#slug-err")).toContainText("Someone just took that address.");
  expect(new URL(page.url()).pathname).toBe("/onboarding/create");

  // Created: on to the project step, with the address saved.
  await page.getByRole("button", { name: "race-lost-hq" }).click();
  await expect(indicator).toHaveText("Available");
  await create.click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await page.goto("/onboarding/create");
  await expect(address).toHaveValue("race-lost-hq");
  await expect(indicator).toHaveText("Yours");
});
