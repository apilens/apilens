// Access › Activity (#812) against the fake identity (e2e-fake/fake-identity.ts) and its measured
// audit seed (35 project events over three weeks): the four states, the filters in the URL, paging,
// a deep link to a filtered view, the detail panel by keyboard, the CSV export, and the not-allowed
// state without `audit.read`. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const VIEWER = ["project.read"];
const ADA = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const PRIYA = "5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8a9b";
const PATH = "/shop/access/activity";

async function seedAudit(body: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

const log = (page: Page) => page.getByRole("region", { name: "Activity log", exact: true });
const rows = (page: Page) => log(page).locator("tbody tr.acl-row");

test.beforeEach(async () => {
  await seedAudit();
  await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});
test.afterAll(async () => {
  await seedAudit();
});

test("lists the project's activity newest first with the retention line, a page at a time", async ({ page }) => {
  await signIn(page, PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  const first = rows(page).first();
  await expect(first.getByRole("button")).toHaveText("Ada Admin rotated key Production backend");
  await expect(first.locator("td").nth(1)).toHaveText("Ada Admin");
  await expect(first.locator("td").nth(4)).toHaveText("203.0.113.24");
  await expect(first.locator("time")).toHaveAttribute("title", / UTC$/);
  await expect(log(page).getByText("The activity log goes back 400 days; older events are deleted.")).toBeVisible();

  const pager = page.getByRole("navigation", { name: "Activity pages" });
  await pager.getByRole("link", { name: "Older" }).click();
  await page.waitForURL((url) => url.searchParams.has("cursor"));
  await expect(rows(page)).toHaveCount(10);
  await expect(rows(page).last().getByRole("button")).toHaveText("Olive Owner created project shop");
  await pager.getByRole("link", { name: "Newer" }).click();
  await page.waitForURL((url) => !url.searchParams.has("cursor"));
  await expect(rows(page)).toHaveCount(25);
});

test("filters by action group and person, in the URL, and clears them", async ({ page }) => {
  await signIn(page, PATH);
  await log(page).getByLabel("Action").selectOption({ label: "API keys" });
  await page.waitForURL((url) => url.searchParams.get("group") === "keys");
  await expect(rows(page)).toHaveCount(6);
  await expect(log(page).getByRole("link", { name: "Export CSV" })).toBeVisible();

  // A group spread over several nouns is read as one merged list, newest first.
  await log(page).getByLabel("Action").selectOption({ label: "Alerts" });
  await page.waitForURL((url) => url.searchParams.get("group") === "alerts");
  await expect(rows(page).getByRole("button")).toHaveText([
    "Priya Patel updated alert rule Checkout p95 over 800 ms",
    "Priya Patel created health check GET /healthz",
    "Priya Patel created alert channel #payments-oncall",
    "Priya Patel created alert rule Checkout p95 over 800 ms",
    "Priya Patel updated alert channel #payments-oncall",
    "Fake User deleted health check GET /status",
  ]);
  await expect(log(page).getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await expect(log(page).getByText("Clear the Alerts filter to export.", { exact: false })).toBeVisible();

  await log(page).getByLabel("Action").selectOption({ label: "All actions" });
  await page.waitForURL((url) => !url.searchParams.has("group"));
  await expect(rows(page)).toHaveCount(25);
  await log(page).getByLabel("Person").selectOption({ label: "Priya Patel" });
  await page.waitForURL((url) => url.searchParams.get("who") === PRIYA && !url.searchParams.has("group"));
  await expect(rows(page)).toHaveCount(11);

  await log(page).getByRole("link", { name: "Clear filters" }).click();
  await page.waitForURL((url) => url.search === "");
  await expect(rows(page)).toHaveCount(25);
});

test("a deep link opens a filtered view", async ({ page }) => {
  await signIn(page, `${PATH}?group=access&who=${ADA}`);
  await expect(log(page).getByLabel("Action")).toHaveValue("access");
  await expect(log(page).getByLabel("Person")).toHaveValue(ADA);
  await expect(rows(page).getByRole("button")).toHaveText([
    "Ada Admin changed tom@example.com’s role to Editor",
    "Ada Admin added tom@example.com to the project as Viewer",
    "Ada Admin removed former@example.com from the project",
    "Ada Admin added priya@example.com to the project as Admin",
  ]);

  await page.goto(`${PATH}?from=2020-01-01&to=2020-01-31`);
  await expect(log(page).getByLabel("From")).toHaveValue("2020-01-01");
  await expect(log(page).getByRole("heading", { name: "No activity matches these filters" })).toBeVisible();
});

test("the detail panel opens from the keyboard, shows every field and the changes, and closes with Escape", async ({ page }) => {
  await signIn(page, PATH);
  const open = rows(page).nth(1).getByRole("button");
  await open.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Ada Admin changed tom@example.com’s role to Editor" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("project_member.role_changed")).toBeVisible();
  await expect(panel.getByText("203.0.113.24")).toBeVisible();
  await expect(panel.getByText("req_0013f8a2c")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copy request id" })).toBeVisible();
  const change = panel.getByRole("table").getByRole("row", { name: /role/ });
  await expect(change.locator("td")).toHaveText(["viewer", "editor"]);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();

  // A click on the row opens it too; the close button closes it.
  await rows(page).first().locator("td").first().click();
  const keyPanel = page.getByRole("dialog", { name: "Ada Admin rotated key Production backend" });
  await expect(keyPanel.getByText("This event records no changed fields.")).toBeVisible();
  await keyPanel.getByRole("button", { name: "Close event details" }).click();
  await expect(keyPanel).toBeHidden();
});

test("exports the current filter as CSV", async ({ page }) => {
  await signIn(page, `${PATH}?group=keys`);
  const href = await log(page).getByRole("link", { name: "Export CSV" }).getAttribute("href");
  expect(href).toBe("/api/projects/shop/audit-export?group=keys");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  const lines = (await res.text()).trim().split("\n");
  expect(lines[0]).toMatch(/^timestamp,action,/);
  expect(lines.slice(1)).toHaveLength(6);
  expect(lines.slice(1).every((l) => l.split(",")[1].startsWith("api_key."))).toBe(true);

  const multi = await page.request.get("/api/projects/shop/audit-export?group=alerts");
  expect(multi.status()).toBe(422);
});

test("empty and error states", async ({ page }) => {
  await seedAudit({ events: [] });
  await signIn(page, PATH);
  await expect(log(page).getByRole("heading", { name: "No activity yet" })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  await seedAudit({ down: true });
  await page.reload();
  await expect(page.locator("p[role=alert]")).toHaveText("Couldn’t load the activity log. Reload the page to try again.");
});

test("without audit.read the tab is hidden and a direct link shows the not-allowed state", async ({ page }) => {
  await signIn(page, "/shop/access", VIEWER);
  await expect(page.getByRole("navigation", { name: "Access", exact: true }).getByRole("link")).toHaveText(["Members", "API keys"]);
  const res = await page.goto(PATH);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You can’t see this project’s activity log" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity log", exact: true })).toHaveCount(0);
});

// Visual check (light/dark at 1440 and 390): `ACTIVITY_SHOTS=<dir> pnpm test:e2e:fake access-activity`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ACTIVITY_SHOTS;
  test.skip(!dir, "set ACTIVITY_SHOTS to a directory to capture screenshots");
  await signIn(page, PATH);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(PATH);
      await expect(rows(page)).toHaveCount(25);
      await page.screenshot({ path: `${dir}/activity-${theme}-${width}.png` });
      await rows(page).nth(1).getByRole("button").click();
      await page.screenshot({ path: `${dir}/activity-detail-${theme}-${width}.png` });
      await page.keyboard.press("Escape");
    }
  }
});
