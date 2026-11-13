// Project settings → General (#815) against the fake identity (e2e-fake/fake-identity.ts), which
// serves `GET|PATCH /projects/shop` and resume from the seeded project (`/__fake/project`), and
// the creator's name from `GET /projects/shop/access`. No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const GENERAL = "/shop/settings";
const ADMIN = ["project.read", "project.update", "project.delete"];
const EDITOR = ["project.read", "project.update"];
const VIEWER = ["project.read"];
const SHOP_ID = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const OLIVE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

async function seedProject(body: Record<string, unknown>) {
  await fetch(`${IDENTITY}/__fake/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: GENERAL, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === GENERAL);
}

const details = (page: Page) => page.getByRole("form", { name: "Details" });
const identifiers = (page: Page) => page.getByRole("region", { name: "Identifiers" });

test.beforeEach(async () => {
  await seedProject({});
  await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

test.afterAll(async () => {
  await seedProject({});
});

test("shows the details and identifiers with copy controls", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
  await expect(page).toHaveTitle(/^General · Project settings/);
  await expect(details(page).getByLabel("Name")).toHaveValue("Shop");
  await expect(details(page).getByLabel("Description")).toHaveValue("Storefront API: catalogue, cart and checkout.");
  await expect(details(page).getByText("45 / 280")).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Save" })).toBeDisabled();

  const ids = identifiers(page);
  await expect(ids.getByText("shop", { exact: true })).toBeVisible();
  await expect(ids.getByText(SHOP_ID)).toBeVisible();
  await expect(ids.getByRole("button", { name: "Copy slug" })).toBeVisible();
  await expect(ids.getByRole("button", { name: "Copy project ID" })).toBeVisible();
  await expect(ids).toContainText("Olive Owner ·");
  await expect(page.getByRole("region", { name: "Ingest is paused" })).toHaveCount(0);
});

test("edits and saves; the new name shows in the sidebar and header without a reload", async ({ page }) => {
  await signIn(page, EDITOR);
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 815));
  const form = details(page);
  await form.getByLabel("Name").fill("  Shop API ");
  await form.getByLabel("Description").fill("Checkout and cart.");
  await expect(form.getByText("18 / 280")).toBeVisible();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
  await expect(form.getByLabel("Name")).toHaveValue("Shop API");
  await expect(page.getByRole("button", { name: "Project Shop API. Switch project" })).toBeVisible();
  await expect(page.getByText("Shop API · Settings")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(815);

  await page.reload();
  await expect(details(page).getByLabel("Name")).toHaveValue("Shop API");
  await expect(details(page).getByLabel("Description")).toHaveValue("Checkout and cart.");
});

test("shows validation errors next to the fields", async ({ page }) => {
  await signIn(page);
  const form = details(page);
  await form.getByLabel("Name").fill("   ");
  await form.getByLabel("Description").fill("x".repeat(281));
  await expect(form.getByText("281 / 280")).toBeVisible();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("Name")).toHaveAccessibleDescription("Enter a project name.");
  await expect(form.getByLabel("Description")).toHaveAccessibleDescription(/281 \/ 280 Use at most 280 characters\./);
  await expect(form.getByRole("status")).toHaveText("Fix the highlighted fields to save.");
  await expect(form.getByLabel("Name")).toBeFocused();

  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByLabel("Name")).toHaveValue("Shop");
  await expect(form.getByLabel("Name")).not.toHaveAttribute("aria-invalid", "true");
});

test("a viewer sees the settings read-only", async ({ page }) => {
  await signIn(page, VIEWER);
  await expect(page.getByText("You can see these settings. Only project admins and editors can change them.")).toBeVisible();
  const form = details(page);
  await expect(form.getByLabel("Name")).toBeDisabled();
  await expect(form.getByLabel("Description")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(identifiers(page).getByRole("button", { name: "Copy project ID" })).toBeEnabled();
});

test("an empty description reads as such for a viewer", async ({ page }) => {
  await seedProject({ project: { description: "" } });
  await signIn(page, VIEWER);
  await expect(details(page).getByText("No description yet.")).toBeVisible();
});

test("a paused project shows a notice and an admin resumes it", async ({ page }) => {
  await seedProject({ project: { paused_at: new Date(Date.now() - 3_600_000).toISOString(), paused_by: OLIVE } });
  await signIn(page);
  const notice = page.getByRole("region", { name: "Ingest is paused" });
  await expect(notice).toContainText("by Olive Owner, the ingest edge refuses data sent with this project’s keys.");
  await notice.getByRole("button", { name: "Resume ingest" }).click();
  await expect(notice).toHaveCount(0);
});

test("an editor sees the paused notice without Resume", async ({ page }) => {
  await seedProject({ project: { paused_at: new Date().toISOString(), paused_by: null } });
  await signIn(page, EDITOR);
  const notice = page.getByRole("region", { name: "Ingest is paused" });
  await expect(notice).toContainText("A project admin can resume it.");
  await expect(notice.getByRole("button")).toHaveCount(0);
});

test("says so when the project cannot be loaded", async ({ page }) => {
  await seedProject({ down: true });
  await signIn(page);
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load" })).toHaveText("Couldn’t load this project’s settings. Reload the page to try again.");
  await expect(page.getByRole("form", { name: "Details" })).toHaveCount(0);
});

// Visual check (light/dark at 1440 and 390): `GENERAL_SHOTS=<dir> pnpm test:e2e:fake project-general`.
test("screenshots", async ({ page }) => {
  const dir = process.env.GENERAL_SHOTS;
  test.skip(!dir, "set GENERAL_SHOTS to a directory to capture screenshots");
  await seedProject({ project: { paused_at: new Date().toISOString(), paused_by: OLIVE } });
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(GENERAL);
      await page.screenshot({ path: `${dir}/general-${theme}-${width}.png`, fullPage: true });
    }
  }
});
