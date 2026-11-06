// Traffic (#592) against the fake identity (e2e-fake/fake-identity.ts), which plays the query
// role: `GET /traffic/summary`, `/traffic/timeseries` and `/traffic/endpoints` answer what
// `/__fake/traffic` seeded, per environment; `/__fake/query-down` makes them answer 503. No email
// is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/traffic";

const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();

const SUMMARY = {
  from: "",
  to: "",
  requests: 12_400,
  client_errors: 310,
  server_errors: 62,
  error_rate: 0.03,
  p50_ms: 38.2,
  p95_ms: 412.6,
  p99_ms: 1240,
  requests_per_minute: 8.61,
  apdex: 0.912,
};

const POINTS = [
  { ts: bucket(0), requests: 3000, client_errors: 60, server_errors: 0, p95_ms: 380 },
  { ts: bucket(1), requests: 3400, client_errors: 100, server_errors: 12, p95_ms: 420 },
  { ts: bucket(2), requests: 2600, client_errors: 50, server_errors: 40, p95_ms: 610 },
  { ts: bucket(3), requests: 3400, client_errors: 100, server_errors: 10, p95_ms: 300 },
];

const ENDPOINTS = [
  { method: "GET", path: "/orders/{id}", requests: 8200, client_errors: 290, server_errors: 2, error_rate: 0.035, p50_ms: 31, p95_ms: 220.4, apdex: 0.97 },
  { method: "POST", path: "/charge", requests: 4200, client_errors: 20, server_errors: 60, error_rate: 0.019, p50_ms: 410, p95_ms: 1820, apdex: 0.61 },
];

const PRODUCTION = {
  summary: { ...SUMMARY, requests: 9000, client_errors: 90, server_errors: 9, p95_ms: 388, apdex: 0.95 },
  points: POINTS.slice(0, 2),
  endpoints: ENDPOINTS.slice(0, 1).map((e) => ({ ...e, requests: 9000 })),
};

async function seed(envs: Record<string, unknown> = { "": { summary: SUMMARY, points: POINTS, endpoints: ENDPOINTS }, production: PRODUCTION }) {
  const res = await fetch(`${IDENTITY}/__fake/traffic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", envs }),
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

async function signIn(page: Page, next = PAGE) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const tiles = (page: Page) => page.locator("dl.tr-tiles .tr-tile__value");
const endpointsTable = (page: Page) => page.getByRole("table", { name: "Endpoints" });

/** The hover tooltip of chart `name` at bucket `i` (0-based), reached with the keyboard. */
async function tipAt(page: Page, name: RegExp, i: number) {
  const box = page.getByRole("group", { name });
  await box.focus();
  await page.keyboard.press("Home");
  for (let k = 0; k < i; k++) await page.keyboard.press("ArrowRight");
  return box.locator(".ct-tip");
}

/** Forgets every saved endpoint setting (#600) and puts back shop's one app. */
async function resetSettings() {
  await fetch(`${IDENTITY}/__fake/endpoint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", method: "GET", path: "/orders/{id}", tabs: {} }),
  });
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps: [] }) });
}

test.afterEach(async () => {
  await resetSettings();
  await queryDown(false);
  // Other specs read shop's traffic from the requests the fake edge stored.
  await seed({});
});

test("shows requests, errors, latency and Apdex tiles, the status-split chart and the endpoints", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Traffic" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Traffic" })).toHaveAttribute("aria-current", "page");

  const summary = page.locator("dl.tr-tiles");
  await expect(summary.locator("dt")).toHaveText(["Requests", "Error rate", "p95 response time", "Apdex"]);
  await expect(tiles(page)).toHaveText(["12,400", "3.0%", "413 ms", "0.91"]);
  await expect(summary.locator(".tr-tile__sub")).toHaveText(["8.6 per minute", "310 4xx, 62 5xx", "p50 38 ms, p99 1.24 s", "Good"]);
  await expect(summary.locator(".tr-spark polyline")).toHaveCount(3);

  const status = page.getByRole("img", { name: /Requests by status/ });
  await expect(status).toHaveAttribute("aria-label", /12,400 requests in the last 24 hours: 310 4xx and 62 5xx/);
  await expect(page.getByRole("list", { name: "Requests by status legend" }).getByRole("listitem")).toHaveText(["Successful", "4xx", "5xx"]);
  // One hover target per bucket, its values in the tooltip; 4xx and 5xx differ in color too.
  await expect(status.locator(".tr-hit")).toHaveCount(4);
  const tip = await tipAt(page, /^Requests by status\. Use the arrow keys/, 1);
  await expect(tip.locator("dt")).toHaveText(["Requests", "Successful", "4xx", "5xx"]);
  await expect(tip.locator("dd")).toHaveText(["3,400", "3,288 (96.7%)", "100 (2.9%)", "12 (0.4%)"]);
  await expect(status.locator(".tr-hit.is-on")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  const fill = (cls: string) => status.locator(cls).first().evaluate((el) => getComputedStyle(el).fill);
  expect(await fill(".tr-fill-4xx")).not.toBe(await fill(".tr-fill-5xx"));
  await expect(page.getByRole("img", { name: /Response time/ })).toHaveAttribute("aria-label", /p95 of 413 ms/);

  await expect(endpointsTable(page).getByRole("columnheader")).toHaveText(["Endpoint", "Requests", "4xx", "5xx", "p50", "p95", "Apdex", "Settings"]);
  const rows = endpointsTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole("cell")).toHaveText(["GET /orders/{id}", "8,200", "290 (3.5%)", "2 (<0.1%)", "31 ms", "220 ms", "0.97", ""]);
  await expect(rows.nth(1).getByRole("cell")).toHaveText(["POST /charge", "4,200", "20 (0.5%)", "60 (1.4%)", "410 ms", "1.82 s", "0.61", ""]);

  const a11y = await new AxeBuilder({ page }).include(".tr").analyze();
  expect(a11y.violations).toEqual([]);
});

test("draws the charts at their measured width on first load, never blank", async ({ page }) => {
  await seed();
  await signIn(page);
  for (const name of [/Requests by status/, /Response time/]) {
    const svg = page.getByRole("img", { name });
    // The client measured the plot box and draws at its real width (v1 drew at width(-1) and late).
    await expect(svg).toHaveAttribute("data-measured", /^\d+$/);
    const { measured, box, viewBox } = await svg.evaluate((el) => ({
      measured: Number(el.getAttribute("data-measured")),
      box: Math.round((el.parentElement as HTMLElement).getBoundingClientRect().width),
      viewBox: el.getAttribute("viewBox"),
    }));
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - box)).toBeLessThanOrEqual(1);
    expect(viewBox).toBe(`0 0 ${measured} 160`);
  }
  await expect(page.getByRole("img", { name: /Requests by status/ }).locator(".tr-fill-ok")).toHaveCount(4);
  await expect(page.getByRole("img", { name: /Response time/ }).locator("path.tr-line")).toHaveAttribute("d", /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){3}$/);

  // Resizing redraws at the new width.
  const before = Number(await page.getByRole("img", { name: /Requests by status/ }).getAttribute("data-measured"));
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByRole("img", { name: /Requests by status/ })).not.toHaveAttribute("data-measured", String(before));
});

test("draws the charts before JavaScript runs", async ({ browser }) => {
  // Server-rendered at the fixed viewBox, stretched to the box: the first paint already has bars.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await seed();
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.goto(PAGE);
  const svg = page.getByRole("img", { name: /Requests by status/ });
  await expect(svg).toHaveAttribute("viewBox", "0 0 960 160");
  await expect(svg.locator(".tr-fill-ok")).toHaveCount(4);
  await context.close();
});

test("opens an endpoint's detail from its row, keeping the scope", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?range=7d`);
  const link = endpointsTable(page).getByRole("link", { name: "POST /charge" });
  await expect(link).toHaveAttribute("href", "/shop/endpoints/POST/%2Fcharge?range=7d");
  // The link covers its row: a click anywhere on the row follows it.
  const row = endpointsTable(page).locator("tbody tr").nth(1);
  await row.scrollIntoViewIfNeeded();
  const cell = await row.getByRole("cell").nth(3).boundingBox();
  if (!cell) throw new Error("the 5xx cell has no box");
  await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.waitForURL((url) => url.pathname === "/shop/endpoints/POST/%2Fcharge");
});

test("filters by range and environment, kept in the URL", async ({ page }) => {
  await seed();
  await signIn(page);
  const ranges = page.getByRole("navigation", { name: "Time range" });
  await expect(ranges.getByRole("link", { name: "24h" })).toHaveAttribute("aria-current", "page");
  await ranges.getByRole("link", { name: "1h" }).click();
  await page.waitForURL(/range=1h/);
  await expect(ranges.getByRole("link", { name: "1h" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("img", { name: /Requests by status/ })).toHaveAttribute("aria-label", /in the last 1 hour:/);

  const env = page.getByRole("combobox", { name: "Environment" });
  await expect(env).toHaveValue("");
  await env.selectOption("production");
  await page.waitForURL(/range=1h&env=production/);
  await expect(tiles(page)).toHaveText(["9,000", "1.1%", "388 ms", "0.95"]);
  await expect(page.getByRole("img", { name: /Requests by status/ })).toHaveAttribute("aria-label", /in the last 1 hour in production/);
  await expect(page.getByRole("img", { name: /Requests by status/ }).locator(".tr-hit")).toHaveCount(2);
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(1);
  await expect(endpointsTable(page).getByRole("link", { name: "GET /orders/{id}" })).toHaveAttribute("href", "/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=1h&env=production");
  // The range links keep the environment.
  await expect(ranges.getByRole("link", { name: "7d" })).toHaveAttribute("href", "/shop/traffic?range=7d&env=production");
});

test("pages the endpoints table in the URL, starting again at page 1 when the scope changes", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ENDPOINTS[0], path: `/items/${String(i).padStart(2, "0")}`, requests: 1000 - i }));
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints: many }, production: { ...PRODUCTION, endpoints: many.slice(0, 3) } });
  await signIn(page);
  const pages = page.getByRole("navigation", { name: "Endpoints pages" });
  await expect(pages).toContainText("Showing 1–25 of 30");
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(25);
  await pages.getByRole("link", { name: /Next/ }).click();
  await page.waitForURL(/page=2/);
  await expect(pages).toContainText("Showing 26–30 of 30");
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(5);
  await expect(endpointsTable(page).getByRole("link", { name: "GET /items/29" })).toBeVisible();
  // A page past the end shows the last page.
  await page.goto(`${PAGE}?page=9`);
  await expect(pages).toContainText("Showing 26–30 of 30");
  // A narrower scope drops the page; one page of rows has no controls.
  await page.getByRole("combobox", { name: "Environment" }).selectOption("production");
  await page.waitForURL((url) => url.searchParams.get("env") === "production" && !url.searchParams.has("page"));
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(3);
  await expect(pages).toHaveCount(0);
});

test("stays live with a pause", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.locator(".tr-live__state")).toHaveText("Live");
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toHaveAttribute("aria-pressed", "false");
  await pause.click();
  await expect(page.locator(".tr-live__state")).toHaveText("Paused");
  await expect(page.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator(".tr-live__state")).toHaveText("Live");
});

test("says so when there is no traffic in the scope", async ({ page }) => {
  await seed({ "": { summary: { ...SUMMARY, requests: 0, client_errors: 0, server_errors: 0, apdex: null }, points: [], endpoints: [] } });
  await signIn(page, `${PAGE}?range=6h`);
  await expect(page.getByRole("status").filter({ hasText: "No requests in the last 6 hours." })).toBeVisible();
  await expect(endpointsTable(page)).toHaveCount(0);
});

test("says so when the query API cannot answer, with a way to try again", async ({ page }) => {
  await seed();
  await queryDown(true);
  await signIn(page);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load traffic just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(2);
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page);
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(2);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The row's settings button stays on the row and opens its menu.
  await endpointsTable(page).getByRole("button", { name: "Settings for POST /charge" }).click();
  await expect(page.getByRole("menu", { name: "Settings for POST /charge" })).toBeInViewport();
});

// The endpoint row menu (#600) ---------------------------------------------------------------

const rowMenu = (page: Page, ep: string) => page.getByRole("menu", { name: `Settings for ${ep}` });

async function openRowMenu(page: Page, ep: string) {
  await endpointsTable(page).getByRole("button", { name: `Settings for ${ep}` }).click();
  const menu = rowMenu(page, ep);
  await expect(menu).toBeVisible();
  // The settings load when the menu opens.
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toBeEnabled();
  return menu;
}

test("the row menu marks 404 as expected and takes it back", async ({ page }) => {
  await seed();
  await signIn(page);
  const trigger = endpointsTable(page).getByRole("button", { name: "Settings for GET /orders/{id}" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  let menu = await openRowMenu(page, "GET /orders/{id}");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText(["Mark 404 as expected", "Exclude from metrics"]);
  await expect(menu.getByRole("menuitem", { name: /^Response time threshold/ })).toContainText("App default");
  const a11y = await new AxeBuilder({ page }).include(".org-pop").analyze();
  expect(a11y.violations).toEqual([]);

  const mark = menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" });
  await expect(mark).toHaveAttribute("aria-checked", "false");
  await mark.click();
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "GET /orders/{id} no longer counts 404 responses as client errors." })).toBeVisible();

  menu = await openRowMenu(page, "GET /orders/{id}");
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" }).click();
  await expect(page.getByRole("status").filter({ hasText: "GET /orders/{id} counts 404 responses as client errors again." })).toBeVisible();
  menu = await openRowMenu(page, "GET /orders/{id}");
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("the row menu sets the response time threshold in a small form", async ({ page }) => {
  await seed();
  await signIn(page);
  const menu = await openRowMenu(page, "POST /charge");
  await menu.getByRole("menuitem", { name: /^Response time threshold/ }).click();
  const form = page.getByRole("dialog", { name: "Response time threshold for POST /charge" });
  await expect(form).toBeVisible();
  const field = form.getByRole("textbox", { name: "Response time threshold (ms)" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");

  await field.fill("0");
  await form.getByRole("button", { name: "Save threshold" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter whole milliseconds from 1 to 600,000, or leave it empty for the app default.");
  await expect(field).toHaveAttribute("aria-invalid", "true");

  await field.fill("1500");
  await form.getByRole("button", { name: "Save threshold" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "POST /charge counts requests slower than 1,500 ms as slow." })).toBeVisible();

  // Reopened, the menu and its form show the saved threshold.
  const again = await openRowMenu(page, "POST /charge");
  await expect(again.getByRole("menuitem", { name: /^Response time threshold/ })).toContainText("1,500 ms");
  await again.getByRole("menuitem", { name: /^Response time threshold/ }).click();
  await expect(page.getByRole("textbox", { name: "Response time threshold (ms)" })).toHaveValue("1500");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(rowMenu(page, "POST /charge")).toBeVisible();
});

test("the row menu excludes an endpoint from metrics", async ({ page }) => {
  await seed();
  await signIn(page);
  const menu = await openRowMenu(page, "POST /charge");
  await menu.getByRole("menuitemcheckbox", { name: "Exclude from metrics" }).click();
  await expect(page.getByRole("status").filter({ hasText: "POST /charge is excluded from metrics." })).toBeVisible();
  // The table reads itself again and leaves the endpoint out.
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(1);
  await expect(endpointsTable(page).getByRole("link", { name: "POST /charge" })).toHaveCount(0);

  // Its endpoint page says so and can include it again.
  await page.goto("/shop/endpoints/POST/%2Fcharge");
  await expect(page.locator(".ep-badge")).toHaveText("Excluded from dashboards");
});

test("the row menu is read-only without capture.manage", async ({ page }) => {
  await seed();
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE, capabilities: ["project.read"] }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  await endpointsTable(page).getByRole("button", { name: "Settings for GET /orders/{id}" }).click();
  const menu = rowMenu(page, "GET /orders/{id}");
  await expect(menu.getByText("Only project admins can change endpoint settings.")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Response time threshold/ })).toContainText("App default");
  for (const item of await menu.getByRole("menuitemcheckbox").all()) await expect(item).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Response time threshold/ })).toBeDisabled();
});

test("the row menu picks the app when the project has several", async ({ page }) => {
  const shop = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
  const billing = "8a2d3b4c-5e6f-4a71-9bac-1d2e3f4a5b6c";
  await fetch(`${IDENTITY}/__fake/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apps: [{ id: shop, slug: "shop", name: "Shop" }, { id: billing, slug: "billing", name: "Billing" }] }),
  });
  await seed();
  await signIn(page);
  let menu = await openRowMenu(page, "GET /orders/{id}");
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Shop", "Billing"]);
  await expect(menu.getByRole("menuitemradio", { name: "Shop" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Billing" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Billing" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toBeEnabled();
  await menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" }).click();
  await expect(page.getByRole("status").filter({ hasText: "no longer counts 404 responses" })).toBeVisible();

  // Saved for Billing only.
  menu = await openRowMenu(page, "GET /orders/{id}");
  await expect(menu.getByRole("menuitemradio", { name: "Billing" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Shop" }).click();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toBeEnabled();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Mark 404 as expected" })).toHaveAttribute("aria-checked", "false");
});
