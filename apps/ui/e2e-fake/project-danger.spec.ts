// Project settings → Danger zone (#821) against the fake identity (e2e-fake/fake-identity.ts),
// which serves pause/resume, rename and delete for the seeded project shop (`/__fake/project`
// resets it) and lists shop in the context under its current slug, or not at all once deleted.
// The re-authentication code is the fake's fixed 123456: no email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const DANGER = "/shop/settings/danger";
const ADMIN = ["project.read", "project.update", "project.delete"];
const EDITOR = ["project.read", "project.update"];

async function seedProject(body: Record<string, unknown> = {}) {
  await fetch(`${IDENTITY}/__fake/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, capabilities: string[] = ADMIN, stale = false) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: DANGER, capabilities, stale }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === DANGER);
}

const card = (page: Page) => page.getByRole("region", { name: "Pause, rename or delete" });
const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const reauth = (page: Page) => page.getByRole("dialog", { name: "Confirm it’s you" });

test.beforeEach(async () => {
  await seedProject();
});

test.afterAll(async () => {
  await seedProject();
});

test("shows the three actions with what each one does", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Danger zone" })).toBeVisible();
  await expect(page).toHaveTitle(/^Danger zone · Project settings/);
  const c = card(page);
  await expect(c).toContainText("Pause data collection");
  await expect(c).toContainText("Links to /shop redirect to the new slug");
  await expect(c).toContainText("Its data is removed after 7 days; until then an organization admin can restore it.");
  await expect(c.getByRole("button", { name: "Pause data collection" })).toBeEnabled();
  await expect(c.getByRole("button", { name: "Delete project" })).toBeEnabled();
});

test("pauses with the typed project name and resumes without a confirmation", async ({ page }) => {
  await signIn(page);
  const c = card(page);
  await c.getByRole("button", { name: "Pause data collection" }).click();
  const d = dialog(page, "Pause data collection for Shop?");
  await expect(d).toBeVisible();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
  const confirm = d.getByRole("button", { name: "Pause data collection" });
  const field = d.getByRole("textbox");
  await field.fill("shop");
  await expect(confirm).toBeDisabled();
  await field.fill("Shop");
  await confirm.click();
  await expect(d).toBeHidden();
  await expect(c.getByRole("status")).toHaveText("Data collection paused. The ingest edge now refuses this project’s data.");
  await expect(c).toContainText("Data collection is paused");

  await c.getByRole("button", { name: "Resume data collection" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(c.getByRole("status")).toHaveText("Data collection resumed.");
  await expect(c.getByRole("button", { name: "Pause data collection" })).toBeVisible();
});

test("renames the slug after the availability check; the old URL redirects", async ({ page }) => {
  await signIn(page);
  const c = card(page);
  const field = c.getByRole("textbox", { name: "New slug" });
  await field.fill("storefront");
  // The first check compiles the availability route under `next dev`: allow for it.
  await expect(c.getByText("Taken", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(field).toHaveAttribute("aria-invalid", "true");

  await field.fill("shop-api");
  await expect(c.getByText("Available")).toBeVisible();
  await c.getByRole("button", { name: "Change slug" }).click();
  const d = dialog(page, "Change the slug to shop-api?");
  await expect(d).toContainText("Links to /shop redirect there");
  await d.getByRole("button", { name: "Change slug" }).click();

  await page.waitForURL((url) => url.pathname === "/shop-api/settings/danger");
  await expect(card(page).getByRole("status")).toHaveText("Slug changed. Links to /shop now redirect here.");

  await page.goto("/shop/settings/danger");
  await page.waitForURL((url) => url.pathname === "/shop-api/settings/danger");
  await expect(page.getByRole("heading", { level: 1, name: "Danger zone" })).toBeVisible();
});

test("delete needs the exact slug; then the project is gone from the switcher without a reload", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 821));
  await card(page).getByRole("button", { name: "Delete project" }).click();
  const d = dialog(page, "Delete Shop?");
  await expect(d).toContainText("Its data is removed after 7 days");
  await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
  const confirm = d.getByRole("button", { name: "Delete Shop" });
  const field = d.getByRole("textbox");
  await field.fill("Shop");
  await expect(confirm).toBeDisabled();
  await field.fill("shop-x");
  await expect(confirm).toBeDisabled();
  await field.fill("shop");
  await confirm.click();

  await page.waitForURL((url) => url.pathname === "/orgs/acme/settings");
  await expect(page.getByRole("status").filter({ hasText: "Project shop was deleted." })).toContainText("an organization admin can restore it");
  await expect(page.getByRole("button", { name: /^Project Shop\. Switch project/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Organization menu$/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /Acme/ })).toContainText("0 projects");
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(821);

  const gone = await page.goto(DANGER);
  expect(gone?.status()).toBe(404);
});

test("a stale sign-in confirms who it is before the delete goes through", async ({ page }) => {
  await signIn(page, ADMIN, true);
  await card(page).getByRole("button", { name: "Delete project" }).click();
  const d = dialog(page, "Delete Shop?");
  await d.getByRole("textbox").fill("shop");
  await d.getByRole("button", { name: "Delete Shop" }).click();

  const r = reauth(page);
  await expect(r).toBeVisible();
  await r.getByRole("button", { name: "Email me a code" }).click();
  await r.getByRole("textbox", { name: "Code from the email we sent you" }).fill("123456");
  await r.getByRole("button", { name: "Confirm" }).click();
  await page.waitForURL((url) => url.pathname === "/orgs/acme/settings");
});

test("without project.delete the actions are disabled with the reason", async ({ page }) => {
  await signIn(page, EDITOR);
  await expect(page.getByText("Only project admins can pause, rename or delete this project. Ask a project admin.")).toBeVisible();
  const c = card(page);
  for (const name of ["Pause data collection", "Change slug", "Delete project"]) {
    const button = c.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("Only project admins can pause, rename or delete this project. Ask a project admin.");
  }
  await expect(c.getByRole("textbox", { name: "New slug" })).toBeDisabled();
});
