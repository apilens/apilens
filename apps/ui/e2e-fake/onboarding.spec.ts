// Onboarding guard (#326) against the fake identity: signed-out visitors go to sign-up, a step
// ahead of the saved one goes back to it, and browser back/forward still works. The fake user's
// context has onboarding open at no saved step (the first one, `about`).
import AxeBuilder from "@axe-core/playwright";
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

/** Signs a new fake user in and creates organization `name`, landing on the project step. */
async function toProjectStep(page: Page, name: string) {
  await page.goto("/sign-in");
  await githubButton(page).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/join");
  await page.getByRole("link", { name: "Create a separate organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();
}

// #331: name, an address checked live against the global project slugs (taken ones offer the
// API's suggestions), environment chips (production and staging to start with, add and remove),
// Create calls `POST /orgs/{org}/projects` in the organization just created and continues to the
// instrument step with `project_slug` saved; coming back shows the project as the user's.
test("Create your first project checks the address, edits environments and creates the project", async ({ page }) => {
  await toProjectStep(page, "Initech");
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Project");
  await expect(page.locator(".ob-p").first()).toContainText("Initech");

  const address = page.getByRole("textbox", { name: /^Address/ });
  const indicator = page.locator(".ob-in .r");
  const create = page.getByRole("button", { name: "Create project" });
  const envs = page.getByRole("list", { name: "Environments" });
  const envInput = page.locator("#project-env");
  await expect(page.locator(".ob-in .pre")).toHaveText("localhost:3210/");

  // A taken address (from the name) says so and offers suggestions; Create stays disabled.
  await page.getByLabel("Name", { exact: true }).fill("Shop");
  await expect(address).toHaveValue("shop");
  await expect(page.locator("#slug-err")).toContainText("That address is taken.");
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "shop-api" }).click();
  await expect(address).toHaveValue("shop-api");
  await expect(indicator).toHaveText("Available");
  await expect(create).toBeEnabled();

  // Environments: production and staging to start with; remove one, add one, refuse a bad name.
  await expect(envs.getByRole("listitem")).toHaveText(["production×", "staging×"]);
  await page.getByRole("button", { name: "Remove staging" }).click();
  await envInput.fill("dev");
  await envInput.press("Enter");
  await expect(envs.getByRole("listitem")).toHaveText(["production×", "dev×"]);
  await envInput.fill("bad!");
  await envInput.press("Enter");
  await expect(page.locator("#env-err")).toContainText("“bad!” isn’t a valid name");
  await expect(envInput).toHaveAttribute("aria-invalid", "true");
  await envInput.fill("");
  await expect(page.locator("#env-err")).toHaveCount(0);

  // Taken between the check and Create: reported on the field, the screen stays.
  await address.fill("race-lost");
  await expect(indicator).toHaveText("Available");
  await create.click();
  await expect(page.locator("#slug-err")).toContainText("Someone just took that address.");
  expect(new URL(page.url()).pathname).toBe("/onboarding/project");

  // Created: on to the instrument step, with the address saved.
  await page.getByRole("button", { name: "race-lost-api" }).click();
  await expect(indicator).toHaveText("Available");
  await create.click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");

  // Coming back resumes on the project created, with its environments.
  await page.goto("/onboarding/project");
  await expect(address).toHaveValue("race-lost-api");
  await expect(indicator).toHaveText("Yours");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Shop");
  await expect(envs.getByRole("listitem")).toHaveText(["dev×", "production×"]);
  await create.click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
});

// #331: visual check of the project step in light and dark at 1440 and 390 px, with axe finding
// no serious or critical violations. Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding`.
test("Create your first project passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(120_000);
  await toProjectStep(page, "Umbrella");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad, `${theme} at ${width} px`).toEqual([]);
      // Nothing scrolls sideways on a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shots = process.env.AUTH_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/onboarding-project-${theme}-${width}.png`, fullPage: true });
    }
  }
});
