// Project settings › Environments (#816) against the fake identity (e2e-fake/fake-identity.ts),
// which seeds shop with five environments: production, staging and canary with data, an empty
// preview and a hidden qa-legacy (`/__fake/environments` resets them). Covers the four states,
// add, reorder, colour, mark as production, hide, remove (refused with the reason, and allowed),
// the Traffic picker following the order and hidden state, and the viewer's read-only list.
// No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ENVS = "/shop/settings/environments";
const EDITOR = ["project.read", "project.update"];
const VIEWER = ["project.read"];

async function post(path: string, body: unknown) {
  await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, capabilities: string[] = EDITOR, next = ENVS) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const ordered = (page: Page) => page.getByRole("list", { name: "Environments in order" });
const row = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
const status = (page: Page) => page.getByRole("status").first();

test.beforeEach(async () => {
  await post("/__fake/environments", {});
  await post("/__fake/project", {});
});

test.afterAll(async () => {
  await post("/__fake/environments", {});
  await post("/__fake/project", {});
});

test("lists the environments in order with where they came from, and the hidden ones collapsed", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Environments" })).toBeVisible();
  await expect(page.getByText("5 of 20 environments used")).toBeVisible();
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary", "preview"]);

  const prod = row(page, "production");
  await expect(prod.getByText("Production", { exact: true })).toBeVisible();
  await expect(prod.locator(".env-colour")).toHaveText("Green");
  await expect(prod).toContainText("Reported by the SDK");
  await expect(prod).toContainText("2 keys limited to it");
  await expect(row(page, "preview")).toContainText("Added here · No data yet · No keys limited to it");
  await expect(row(page, "preview").locator(".env-colour")).toHaveText("No colour");

  const hidden = page.getByRole("list", { name: "Hidden environments" });
  await expect(hidden).toBeHidden();
  await page.getByText("Hidden environments 1").click();
  await expect(hidden.getByRole("heading")).toHaveText(["qa-legacy"]);
  await expect(row(page, "qa-legacy").getByRole("button", { name: "Show qa-legacy" })).toBeVisible();
});

test("adds an environment, checking the name first", async ({ page }) => {
  await signIn(page);
  const name = page.getByLabel(/^Name/);
  await name.fill("perf lab");
  await page.getByRole("button", { name: "Add environment" }).click();
  await expect(page.getByText(/Use letters, digits/)).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("perf-lab");
  await page.getByRole("button", { name: "Add environment" }).click();
  await expect(status(page)).toHaveText("Added perf-lab.");
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary", "preview", "perf-lab"]);
  await expect(page.getByText("6 of 20 environments used")).toBeVisible();
  await expect(name).toHaveValue("");
});

test("reorders with the move buttons, and Traffic's picker follows the order without hidden ones", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Move production up" })).toBeDisabled();
  await page.getByRole("button", { name: "Move canary up" }).click();
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "canary", "staging", "preview"]);
  await expect(status(page)).toHaveText("Moved canary up.");
  await expect(page.getByRole("button", { name: "Move canary up" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ordered(page).getByRole("heading")).toHaveText(["canary", "production", "staging", "preview"]);

  await page.reload();
  await expect(ordered(page).getByRole("heading")).toHaveText(["canary", "production", "staging", "preview"]);

  await page.goto("/shop/traffic");
  const picker = page.getByRole("combobox", { name: "Environment" });
  await expect(picker.locator("option")).toHaveText(["All environments", "canary", "production", "staging", "preview"]);
});

test("marks an environment as production and picks its colour by name", async ({ page }) => {
  await signIn(page);
  const staging = row(page, "staging");
  await staging.getByRole("button", { name: "Mark staging as production" }).click();
  await expect(status(page)).toHaveText("staging is marked as production.");
  await expect(staging.getByText("Production", { exact: true })).toBeVisible();
  await expect(staging.getByRole("button", { name: "Unmark staging as production" })).toBeVisible();

  await staging.getByLabel("Colour of staging").selectOption({ label: "Teal" });
  await expect(status(page)).toHaveText("staging is teal now.");
  await expect(staging.locator(".env-colour")).toHaveText("Teal");
  await page.reload();
  await expect(row(page, "staging").getByText("Production", { exact: true })).toBeVisible();
  await expect(row(page, "staging").getByLabel("Colour of staging")).toHaveValue("teal");
});

test("hides an environment, which leaves Traffic's picker, and shows it again", async ({ page }) => {
  await signIn(page);
  await row(page, "preview").getByRole("button", { name: "Hide preview" }).click();
  await expect(status(page)).toHaveText(/preview is hidden/);
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary"]);
  await expect(page.getByText("Hidden environments 2")).toBeVisible();

  await page.goto("/shop/traffic");
  await expect(page.getByRole("combobox", { name: "Environment" }).locator("option")).toHaveText(["All environments", "production", "staging", "canary"]);

  await page.goto(ENVS);
  await page.getByText("Hidden environments 2").click();
  await row(page, "preview").getByRole("button", { name: "Show preview" }).click();
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary", "preview"]);
});

test("refuses to remove an environment with data, explains why and offers Hide", async ({ page }) => {
  await signIn(page);
  const staging = row(page, "staging");
  await staging.getByRole("button", { name: "Remove staging" }).click();
  await expect(staging).toContainText("Can’t be removed because it has data, 1 API key is pinned to it. Hide it instead.");
  const hide = staging.getByRole("button", { name: "Hide staging" }).last();
  await expect(hide).toBeFocused();
  await hide.click();
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "canary", "preview"]);
  await expect(page.getByText("Hidden environments 2")).toBeVisible();
});

test("removes an empty environment after a confirmation that starts on Cancel", async ({ page }) => {
  await signIn(page);
  const preview = row(page, "preview");
  await preview.getByRole("button", { name: "Remove preview" }).click();
  await expect(preview.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview.getByRole("button", { name: "Remove environment" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Remove preview" })).toBeFocused();

  await preview.getByRole("button", { name: "Remove preview" }).click();
  await preview.getByRole("button", { name: "Remove environment" }).click();
  await expect(status(page)).toHaveText("preview was removed.");
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary"]);
  await expect(page.getByText("4 of 20 environments used")).toBeVisible();
});

test("is read-only without project.update", async ({ page }) => {
  await signIn(page, VIEWER);
  await expect(page.getByText("Only project admins and editors can change them.")).toBeVisible();
  await expect(ordered(page).getByRole("heading")).toHaveText(["production", "staging", "canary", "preview"]);
  await expect(page.getByRole("button", { name: /^(Hide|Remove|Move) / })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add an environment" })).toHaveCount(0);
});

test("says when there are none yet", async ({ page }) => {
  await post("/__fake/environments", { environments: [] });
  await signIn(page);
  await expect(page.getByText("No environments yet. One appears here when an SDK sends data from it, or add one below.")).toBeVisible();
  await expect(page.getByText("0 of 20 environments used")).toBeVisible();
});

test("says when they couldn't be loaded", async ({ page }) => {
  await post("/__fake/project", { down: true });
  await signIn(page);
  await expect(page.getByRole("alert")).toHaveText("Couldn’t load this project’s environments. Reload the page to try again.");
});

// Visual check (light/dark at 1440 and 390): `ENVIRONMENTS_SHOTS=<dir> pnpm test:e2e:fake environments`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ENVIRONMENTS_SHOTS;
  test.skip(!dir, "set ENVIRONMENTS_SHOTS to a directory to capture screenshots");
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(ENVS);
      await page.getByText("Hidden environments 1").click();
      await page.screenshot({ path: `${dir}/environments-${theme}-${width}.png`, fullPage: true });
    }
  }
});
