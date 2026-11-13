// Organization settings → Deleted projects (#822) against the fake identity
// (e2e-fake/fake-identity.ts), which lists acme's deleted projects (Legacy checkout seeded, plus
// shop once deleted; `/__fake/project` resets both) and restores them for owners and admins.
// The re-authentication code is the fake's fixed 123456: no email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SETTINGS = "/orgs/acme/settings";
const DANGER = "/shop/settings/danger";

async function seedProject(body: Record<string, unknown> = {}) {
  await fetch(`${IDENTITY}/__fake/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, next: string, opts: { role?: string; stale?: boolean } = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, role: opts.role ?? "owner", stale: opts.stale ?? false }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const card = (page: Page) => page.getByRole("region", { name: "Deleted projects" });
/** The card's own status line (the re-authentication dialog inside it has one too). */
const restoredStatus = (page: Page) => card(page).getByRole("status").filter({ hasText: "is restored." });

async function projectsInOrgMenu(page: Page) {
  await page.getByRole("button", { name: /Organization menu$/ }).click();
  const item = page.getByRole("menuitemradio", { name: /Acme/ });
  const text = await item.textContent();
  await page.keyboard.press("Escape");
  return text ?? "";
}

test.beforeEach(async () => {
  await seedProject();
});

test.afterAll(async () => {
  await seedProject();
});

test("lists a deleted project with relative and exact dates, and restores it with a link", async ({ page }) => {
  await signIn(page, SETTINGS);
  const c = card(page);
  await expect(c).toBeVisible();
  const row = c.getByRole("listitem").filter({ hasText: "Legacy checkout" });
  await expect(row).toContainText("/legacy-checkout");
  await expect(row).toContainText(/Deleted 2 days ago \([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC\)/);
  await expect(row).toContainText(/Removed for good in 4 days \([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC\)/);

  await row.getByRole("button", { name: "Restore Legacy checkout" }).click();
  await expect(restoredStatus(page)).toContainText("Legacy checkout is restored.");
  await expect(c.getByRole("link", { name: "Open Legacy checkout" })).toHaveAttribute("href", "/legacy-checkout/incidents");
  await expect(c.getByRole("listitem")).toHaveCount(0);
  await expect(c).toContainText("No other deleted projects.");
});

test("delete a project, restore it, and it is back in the switcher", async ({ page }) => {
  await signIn(page, DANGER);
  await page.getByRole("region", { name: "Danger zone actions" }).getByRole("button", { name: "Delete project" }).click();
  const d = page.getByRole("dialog", { name: "Delete Shop?" });
  await d.getByRole("textbox").fill("shop");
  await d.getByRole("button", { name: "Delete Shop" }).click();
  await page.waitForURL((url) => url.pathname === SETTINGS);
  expect(await projectsInOrgMenu(page)).toContain("0 projects");

  const c = card(page);
  const row = c.getByRole("listitem").filter({ hasText: "Shop" });
  await expect(row).toContainText("Deleted just now");
  await expect(row).toContainText("Removed for good in 6 days");
  await row.getByRole("button", { name: "Restore Shop" }).click();
  await expect(restoredStatus(page)).toContainText("Shop is restored.");
  // The deleted note above is gone with it, and the switcher lists shop again without a reload.
  await expect(page.getByText("Project shop was deleted.")).toHaveCount(0);
  await expect.poll(() => projectsInOrgMenu(page)).toContain("1 project");

  await c.getByRole("link", { name: "Open Shop" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/incidents");
});

test("a stale sign-in confirms who it is before the restore goes through", async ({ page }) => {
  await signIn(page, SETTINGS, { stale: true });
  await card(page).getByRole("button", { name: "Restore Legacy checkout" }).click();
  const r = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(r).toBeVisible();
  await r.getByRole("button", { name: "Email me a code" }).click();
  await r.getByRole("textbox", { name: "Code from the email we sent you" }).fill("123456");
  await r.getByRole("button", { name: "Confirm" }).click();
  await expect(restoredStatus(page)).toContainText("Legacy checkout is restored.");
});

test("hidden when nothing is deleted, and for members", async ({ page }) => {
  await seedProject({ deleted: [] });
  await signIn(page, SETTINGS);
  await expect(page.getByRole("heading", { level: 2, name: "Email domains" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  await seedProject();
  await signIn(page, SETTINGS, { role: "member" });
  await expect(page.getByRole("heading", { level: 2, name: "Email domains" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});
