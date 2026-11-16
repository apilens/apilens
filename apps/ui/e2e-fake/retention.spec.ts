// Project settings › Retention (#818) against the fake identity (e2e-fake/fake-identity.ts), which
// serves `GET /projects/shop/retention` from `/__fake/retention` {signals?, delay_ms?} and answers
// 503 while `/__fake/project` {down: true}. Every value checked here comes from the seeded API
// answer, not from the page. No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const RETENTION = "/shop/settings/retention";

async function post(path: string, body: Record<string, unknown>) {
  await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, next = RETENTION, capabilities = ["project.read"]) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const card = (page: Page, name: string) => page.getByRole("region", { name });

/** An install that changed every configurable period from its default. */
const CUSTOM = [
  { key: "requests", label: "Requests and their details", period_days: 180, configurable: true, covers: "The request log and request detail." },
  { key: "logs", label: "Logs", period_days: 14, configurable: true, covers: "Log records shown with a trace." },
  { key: "spans", label: "Trace spans", period_days: 7, configurable: true, covers: "The waterfall in request detail." },
  { key: "rollups_1m", label: "Per-minute metrics", period_days: 60, configurable: true, covers: "Short-range charts." },
  { key: "rollups_1h", label: "Hourly metrics", period_days: 730, configurable: true, covers: "Long-range charts." },
  { key: "deploys", label: "Deploys", period_days: 400, configurable: false, covers: "Deploy markers on charts." },
];

test.beforeEach(async () => {
  await post("/__fake/retention", {});
  await post("/__fake/project", {});
});

test.afterAll(async () => {
  await post("/__fake/retention", {});
  await post("/__fake/project", {});
});

test("shows each signal's period and what happens after, from the API", async ({ page }) => {
  await post("/__fake/retention", { signals: CUSTOM });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Retention", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/^Retention · Project settings/);

  const table = card(page, "Retention periods").getByRole("table", { name: "Retention periods" });
  await expect(table.getByRole("rowheader").locator(".rt-label")).toHaveText(CUSTOM.map((s) => s.label));
  await expect(table.getByRole("row").nth(1).getByRole("rowheader")).toContainText("The request log and request detail.");
  await expect(table.locator(".rt-period")).toHaveText(["180 days", "14 days", "7 days", "60 days", "2 years", "400 daysFixed"]);
  await expect(table.getByRole("row").nth(1).getByRole("cell").nth(1)).toHaveText(
    "Deleted with their headers and bodies. Counts and latencies stay in the hourly metrics.",
  );

  // Read-only for everyone: no inputs or buttons on the page's content.
  await expect(page.locator(".rt").getByRole("textbox")).toHaveCount(0);
  await expect(page.locator(".rt").getByRole("button")).toHaveCount(0);

  const who = card(page, "Who can change it");
  await expect(who).toContainText("Only the install’s operator can change it");
  await expect(who.getByRole("link", { name: "How to change retention" })).toHaveAttribute("href", /\/getting-started\/data-privacy#changing-retention-self-hosted$/);
  await expect(page.getByRole("link", { name: "Privacy", exact: true }).first()).toHaveAttribute("href", "/shop/settings/privacy");
});

test("shows the install defaults", async ({ page }) => {
  await signIn(page, RETENTION, ["project.read", "project.update", "project.delete"]);
  const table = card(page, "Retention periods").getByRole("table");
  await expect(table.getByRole("rowheader").locator(".rt-label")).toHaveText(["Requests", "Logs", "Spans", "Per-minute metrics", "Hourly metrics", "Deploys"]);
  await expect(table.locator(".rt-period")).toHaveText(["90 days", "30 days", "30 days", "30 days", "400 days", "400 daysFixed"]);
});

test("says so when the install reports no periods", async ({ page }) => {
  await post("/__fake/retention", { signals: [] });
  await signIn(page);
  await expect(card(page, "Retention periods")).toContainText("This install reports no retention periods.");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(card(page, "Who can change it")).toBeVisible();
});

test("says so when retention could not be loaded", async ({ page }) => {
  await post("/__fake/project", { down: true });
  await signIn(page);
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load retention." })).toHaveText("Couldn’t load retention. Reload the page to try again.");
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("shows a skeleton while the periods load", async ({ page }) => {
  await signIn(page, "/shop/settings/privacy");
  await post("/__fake/retention", { delay_ms: 2500 });
  await page.goto(RETENTION, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Retention", level: 1 })).toBeVisible();
  await expect(page.locator(".rt-loading[aria-busy='true']")).toBeVisible();
  await expect(card(page, "Retention periods").getByRole("table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".rt-loading")).toHaveCount(0);
});

// Visual check (light/dark at 1440 and 390): `RETENTION_SHOTS=<dir> pnpm test:e2e:fake retention`.
test("screenshots", async ({ page }) => {
  const dir = process.env.RETENTION_SHOTS;
  test.skip(!dir, "set RETENTION_SHOTS to a directory to capture screenshots");
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(card(page, "Retention periods").getByRole("table")).toBeVisible();
      await page.screenshot({ path: `${dir}/retention-${theme}-${width}.png`, fullPage: true });
    }
  }
});
