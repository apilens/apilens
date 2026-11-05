// Consumers (#596) against the fake identity (e2e-fake/fake-identity.ts), which plays the query
// role: `GET /consumers` and `GET /consumers/{id}` answer what `/__fake/consumers` seeded, and the
// fake keeps shop's consumer groups (create, rename, delete, assign) like the API, one group per
// consumer. `/__fake/query-down` makes the reads answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/consumers";
const PARTNERS = "0192f0c4-7a1b-7c3d-8e4f-5a6b7c8d9e01";
const INTERNAL = "0192f0c4-7a1b-7c3d-8e4f-5a6b7c8d9e02";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();

const split = (requests: number, client_errors: number, server_errors: number) => ({
  requests,
  successful: requests - client_errors - server_errors,
  client_errors,
  server_errors,
});

const CONSUMERS = [
  { consumer_id: "acme", consumer_name: "Acme Corp", first_seen: ago(20 * 24 * 60), last_seen: ago(2), new: false, ...split(1200, 30, 6), sparkline: [100, 300, 200, 600] },
  { consumer_id: "globex", consumer_name: "", first_seen: ago(90), last_seen: ago(5), new: true, ...split(340, 0, 0), sparkline: [0, 0, 140, 200] },
  { consumer_id: "initech/eu", consumer_name: "Initech EU", first_seen: ago(3 * 24 * 60), last_seen: ago(45), new: false, ...split(80, 4, 0), sparkline: [20, 20, 20, 20] },
];

const POINTS = [
  { ts: bucket(0), consumers: 2, new: 0, returning: 2 },
  { ts: bucket(1), consumers: 2, new: 0, returning: 2 },
  { ts: bucket(2), consumers: 3, new: 1, returning: 2 },
  { ts: bucket(3), consumers: 3, new: 0, returning: 3 },
];

const request = (minutes: number, status: number, path: string) => ({
  timestamp: ago(minutes),
  method: "GET",
  path,
  raw_path: path,
  status_code: status,
  response_time_ms: 42.4,
  environment: "production",
  consumer_id: "acme",
  consumer_name: "Acme Corp",
  trace_id: `t${minutes}`,
});

const ACME = {
  consumer_name: "Acme Corp",
  first_seen: ago(20 * 24 * 60),
  last_seen: ago(2),
  new: false,
  from: "",
  to: "",
  bucket_seconds: 900,
  summary: { ...split(1200, 30, 6), requests_per_minute: 0.83 },
  points: [
    { ts: bucket(0), ...split(100, 0, 0) },
    { ts: bucket(1), ...split(300, 10, 0) },
    { ts: bucket(2), ...split(200, 20, 6) },
    { ts: bucket(3), ...split(600, 0, 0) },
  ],
  recent_requests: [request(2, 200, "/orders/42"), request(3, 404, "/orders/9")],
  recent_errors: [request(3, 404, "/orders/9"), request(9, 503, "/charge")],
};

async function seed(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/consumers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "shop",
      summary: { consumers: 3, new: 1, returning: 2 },
      points: POINTS,
      consumers: CONSUMERS,
      details: { acme: ACME },
      groups: [
        { id: PARTNERS, name: "Partners" },
        { id: INTERNAL, name: "Internal" },
      ],
      assignments: { acme: PARTNERS, "initech/eu": PARTNERS },
      ...extra,
    }),
  });
  expect(res.status).toBe(204);
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", down }),
  });
}

async function signIn(page: Page, next = PAGE, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...extra }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const consumersTable = (page: Page) => page.getByRole("table", { name: "Consumers" });
const groupsTable = (page: Page) => page.getByRole("table", { name: "Consumer groups" });

test.afterEach(async () => {
  await queryDown(false);
});

test("charts unique consumers new vs returning and lists consumers with sparklines", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Consumers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Consumers", exact: true }).first()).toBeVisible();

  const unique = page.getByRole("region", { name: "Unique consumers" });
  await expect(unique.locator("dd")).toHaveText(["3", "1", "2"]);
  await expect(unique.getByRole("img")).toHaveAttribute("aria-label", /3 consumers in the last 24 hours: 1 new, 2 returning/);
  await expect(unique.getByRole("list", { name: /legend/ }).getByRole("listitem")).toHaveText(["Returning", "New"]);
  // One hover target per bucket, the bucket's values in its tooltip.
  await expect(unique.locator(".cs-hit")).toHaveCount(4);
  await expect(unique.locator(".cs-hit title").nth(2)).toHaveText(/Returning: 2\nNew: 1/);
  // New and returning are told apart by color too (accent vs muted ink).
  const fill = (cls: string) => unique.locator(cls).first().evaluate((el) => getComputedStyle(el).fill);
  expect(await fill(".cs-fill-new")).not.toBe(await fill(".cs-fill-returning"));

  await expect(consumersTable(page).getByRole("columnheader")).toHaveText(["Consumer", "Group", "Requests", "Errors", "Last seen"]);
  const rows = consumersTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("cell").nth(0)).toHaveText("Acme Corpacme");
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("Partners");
  await expect(rows.nth(0).getByRole("cell").nth(2)).toHaveText("1,200");
  await expect(rows.nth(0).getByRole("cell").nth(3)).toHaveText("36 (3.0%)");
  await expect(rows.nth(0).locator(".cs-spark polyline")).toHaveCount(1);
  await expect(rows.nth(1).getByRole("cell").nth(0)).toHaveText("globexNew");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("None");
  await expect(rows.nth(1).getByRole("cell").nth(3)).toHaveText("0");

  const a11y = await new AxeBuilder({ page }).include(".cs").analyze();
  expect(a11y.violations).toEqual([]);
});

test("keeps the range in the URL", async ({ page }) => {
  await seed();
  await signIn(page);
  const ranges = page.getByRole("navigation", { name: "Time range" });
  await expect(ranges.getByRole("link", { name: "24h" })).toHaveAttribute("aria-current", "page");
  await ranges.getByRole("link", { name: "7d" }).click();
  await page.waitForURL(/range=7d/);
  await expect(ranges.getByRole("link", { name: "7d" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Unique consumers" }).getByRole("img")).toHaveAttribute("aria-label", /in the last 7 days/);
  await expect(consumersTable(page).getByRole("link", { name: "Acme Corp" })).toHaveAttribute("href", "/shop/consumers?range=7d&consumer=acme");
});

test("opens a consumer's detail with Requests and Errors tabs", async ({ page }) => {
  await seed();
  await signIn(page);
  await consumersTable(page).getByRole("link", { name: "Acme Corp" }).click();
  await page.waitForURL(/consumer=acme/);

  const panel = page.getByRole("region", { name: "Acme Corp" });
  await expect(panel.getByRole("heading", { level: 2, name: "Acme Corp" })).toBeVisible();
  const tabs = panel.getByRole("navigation", { name: "Consumer detail" });
  await expect(tabs.getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");
  await expect(panel.locator(".cs-tiles dd")).toHaveText(["1,200", "0.8", "3.0%"]);
  await expect(panel.getByRole("img", { name: /Requests over time/ })).toBeVisible();
  const recent = panel.getByRole("table", { name: "Recent requests" });
  await expect(recent.locator("tbody tr")).toHaveCount(2);
  await expect(recent.locator("tbody tr").nth(0)).toContainText("GET /orders/42");

  await tabs.getByRole("link", { name: "Errors" }).click();
  await page.waitForURL(/tab=errors/);
  await expect(tabs.getByRole("link", { name: "Errors" })).toHaveAttribute("aria-current", "page");
  await expect(panel.locator(".cs-tiles dd")).toHaveText(["36", "30", "6"]);
  await expect(panel.getByRole("img", { name: /Errors over time/ })).toHaveAttribute("aria-label", /30 4xx and 6 5xx/);
  const errors = panel.getByRole("table", { name: "Recent errors" });
  await expect(errors.locator(".cs-status")).toHaveText(["404", "503"]);

  const a11y = await new AxeBuilder({ page }).include(".cs").analyze();
  expect(a11y.violations).toEqual([]);

  await panel.getByRole("link", { name: "← All consumers" }).click();
  await expect(consumersTable(page)).toBeVisible();
});

test("moves a consumer to another group, one group at a time", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?consumer=acme`);
  const picker = page.getByRole("combobox", { name: "Group" });
  await expect(picker).toHaveValue(PARTNERS);
  await picker.selectOption({ label: "Internal" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to Internal." })).toBeVisible();

  // It left Partners: the groups view counts it under Internal only.
  await page.goto(`${PAGE}?by=groups`);
  const rows = groupsTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole("cell").nth(0)).toHaveText("Internal");
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("1");
  await expect(rows.nth(0).getByRole("cell").nth(2)).toHaveText("1,200");
  await expect(rows.nth(1).getByRole("cell").nth(0)).toHaveText("Partners");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("1");
  await expect(rows.nth(1).getByRole("cell").nth(2)).toHaveText("80");

  // And out of any group.
  await page.goto(`${PAGE}?consumer=acme`);
  await page.getByRole("combobox", { name: "Group" }).selectOption({ label: "No group" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Taken out of its group." })).toBeVisible();
});

test("creates, renames and deletes groups, and filters consumers by one", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?by=groups`);
  const rows = groupsTable(page).locator("tbody tr");
  await expect(rows.locator("td:first-child")).toHaveText(["Internal", "Partners"]);
  await expect(rows.nth(1).getByRole("cell").nth(2)).toHaveText("1,280");

  // Create; a name already used (ignoring case) is refused.
  const name = page.getByLabel("New group");
  await name.fill("partners");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status").filter({ hasText: "This project already has a group with that name." })).toBeVisible();
  await name.fill("  Trial users ");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Created Trial users." })).toBeVisible();
  await expect(rows.locator("td:first-child")).toHaveText(["Internal", "Partners", "Trial users"]);

  // Rename.
  await page.getByRole("button", { name: "Rename Internal" }).click();
  const field = page.getByRole("textbox", { name: "New name for Internal" });
  await expect(field).toBeFocused();
  await field.fill("Staff");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(rows.locator("td:first-child")).toHaveText(["Partners", "Staff", "Trial users"]);

  // Delete, after a confirmation that says what happens to its consumers.
  await page.getByRole("button", { name: "Delete Trial users" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Delete Trial users? Its 0 consumers become ungrouped." })).toBeVisible();
  await page.getByRole("button", { name: "Delete group" }).click();
  await expect(rows.locator("td:first-child")).toHaveText(["Partners", "Staff"]);

  // A group links to its consumers.
  await groupsTable(page).getByRole("link", { name: "Partners" }).click();
  await page.waitForURL(new RegExp(`group=${PARTNERS}`));
  await expect(page.getByText("Group: Partners")).toBeVisible();
  await expect(consumersTable(page).locator("tbody tr")).toHaveCount(2);
  await page.getByRole("link", { name: "Show all consumers" }).click();
  await expect(consumersTable(page).locator("tbody tr")).toHaveCount(3);
});

test("shows groups read-only to viewers", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?by=groups`, { capabilities: ["project.read"] });
  await expect(page.getByText("Only project admins and editors can change them.")).toBeVisible();
  await expect(page.getByLabel("New group")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Rename|Delete/ })).toHaveCount(0);

  await page.goto(`${PAGE}?consumer=acme`);
  await expect(page.getByRole("combobox", { name: "Group" })).toBeDisabled();
  await expect(page.getByText("Only project admins and editors can change it.")).toBeVisible();
});

test("says so when there are no consumers, no groups, or no such consumer", async ({ page }) => {
  await seed({ summary: { consumers: 0, new: 0, returning: 0 }, points: [], consumers: [], groups: [], assignments: {} });
  await signIn(page);
  await expect(page.getByRole("status").filter({ hasText: "No identified consumers in the last 24 hours." })).toBeVisible();
  await expect(consumersTable(page)).toHaveCount(0);

  await page.goto(`${PAGE}?by=groups`);
  await expect(page.getByRole("status").filter({ hasText: "No consumer groups yet." })).toBeVisible();

  await page.goto(`${PAGE}?consumer=nobody`);
  await expect(page.getByRole("status").filter({ hasText: "There’s no consumer with this id in this project." })).toBeVisible();
});

test("says so when the query API cannot answer, with a way to try again", async ({ page }) => {
  await seed();
  await queryDown(true);
  await signIn(page);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load consumers just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(consumersTable(page).locator("tbody tr")).toHaveCount(3);
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page);
  await expect(consumersTable(page).locator("tbody tr")).toHaveCount(3);
  const overflow = () => page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.goto(`${PAGE}?consumer=acme`);
  await expect(page.getByRole("table", { name: "Recent requests" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
