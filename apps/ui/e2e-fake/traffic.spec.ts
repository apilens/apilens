// Traffic (#592) against the fake identity (e2e-fake/fake-identity.ts), which plays the query
// role: `GET /traffic/summary`, `/traffic/timeseries` and `/traffic/endpoints` answer what
// `/__fake/traffic` seeded, per environment; `/__fake/query-down` makes them answer 503. No email
// is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/project/shop/traffic";

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
  current_per_minute: 12,
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

/**
 * `url` reading all environments unless it names one: a URL without `env` reads the project's
 * production environment (#993), and these specs seed and check the all-environments numbers.
 */
function allEnvs(url: string): string {
  const u = new URL(url, "http://x");
  if (!u.searchParams.has("env")) u.searchParams.set("env", "all");
  return `${u.pathname}${u.search}`;
}

async function signIn(page: Page, next = PAGE) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: allEnvs(next) }),
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
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Traffic" })).toHaveAttribute("aria-current", "page");

  const summary = page.locator("dl.tr-tiles");
  await expect(summary.locator("dt")).toHaveText(["Requests", "Error rate", "p95 response time", "Apdex"]);
  await expect(tiles(page)).toHaveText(["12,400", "3.0%", "413 ms", "0.91"]);
  await expect(summary.locator(".tr-tile__sub")).toHaveText(["8.6 per minute · now 12/min", "310 4xx, 62 5xx", "p50 38 ms, p99 1.24 s", "Good"]);
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

test("compares each tile with the previous window, coloured by direction, and hides without one (#1000)", async ({ page }) => {
  const previous = { from: "", to: "", requests: 10_000, client_errors: 100, server_errors: 26, error_rate: 0.0126, p50_ms: 40, p95_ms: 344, p99_ms: 1000, apdex: 0.95 };
  await seed({ "": { summary: { ...SUMMARY, previous }, points: POINTS, endpoints: ENDPOINTS }, production: PRODUCTION });
  await signIn(page);
  const summary = page.locator("dl.tr-tiles");
  await expect(summary.locator(".tr-compare")).toHaveText([
    "▲ 24.0% vs previous 24h",
    "▲ 1.7 pts vs previous 24h",
    "▲ 19.9% vs previous 24h",
    "▼ 0.04 vs previous 24h",
  ]);
  // More requests is neither good nor bad; more errors, slower and a lower Apdex are bad.
  await expect(summary.locator(".tr-compare--neutral")).toHaveCount(1);
  await expect(summary.locator(".tr-compare--bad")).toHaveCount(3);
  const color = (cls: string) => summary.locator(cls).first().evaluate((el) => getComputedStyle(el).color);
  expect(await color(".tr-compare--bad")).not.toBe(await color(".tr-compare--neutral"));
  const a11y = await new AxeBuilder({ page }).include("dl.tr-tiles").analyze();
  expect(a11y.violations).toEqual([]);

  // Production has no previous window: no comparison at all.
  await page.goto(`${PAGE}?env=production`);
  await expect(tiles(page).first()).toHaveText("9,000");
  await expect(summary.locator(".tr-compare")).toHaveCount(0);
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
  await page.goto(allEnvs(PAGE));
  const svg = page.getByRole("img", { name: /Requests by status/ });
  await expect(svg).toHaveAttribute("viewBox", "0 0 960 160");
  await expect(svg.locator(".tr-fill-ok")).toHaveCount(4);
  await context.close();
});

test("opens an endpoint's detail from its row, keeping the scope", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?range=7d`);
  const link = endpointsTable(page).getByRole("link", { name: "POST /charge" });
  await expect(link).toHaveAttribute("href", "/project/shop/endpoints/POST/%2Fcharge?range=7d&env=all");
  // The link covers its row: a click anywhere on the row follows it, but for the error counts and
  // p95, which open their requests in Explore (#977).
  const row = endpointsTable(page).locator("tbody tr").nth(1);
  await row.scrollIntoViewIfNeeded();
  const cell = await row.getByRole("cell").nth(1).boundingBox();
  if (!cell) throw new Error("the Requests cell has no box");
  await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.waitForURL((url) => url.pathname === "/project/shop/endpoints/POST/%2Fcharge");
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
  await expect(endpointsTable(page).getByRole("link", { name: "GET /orders/{id}" })).toHaveAttribute("href", "/project/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=1h&env=production");
  // The range links keep the environment.
  await expect(ranges.getByRole("link", { name: "7d" })).toHaveAttribute("href", "/project/shop/traffic?range=7d&env=production");
});

test("without a range or environment in the URL: the range covering the first data, production, then the last choice (#993)", async ({ page }) => {
  const ingested = (last_at: string | null) =>
    fetch(`${IDENTITY}/__fake/ingested`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", last_at }) });
  await seed();
  // A project whose first request arrived 30 minutes ago reads the last hour, in production.
  await ingested(new Date(Date.now() - 30 * 60_000).toISOString());
  try {
    const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next: PAGE }) });
    const { code } = (await res.json()) as { code: string };
    await page.goto(`/auth/callback?code=${code}`);
    await page.waitForURL((url) => url.pathname === PAGE);
    const ranges = page.getByRole("navigation", { name: "Time range" });
    const env = page.getByRole("combobox", { name: "Environment" });
    await expect(ranges.getByRole("link", { name: "1h" })).toHaveAttribute("aria-current", "page");
    await expect(env).toHaveValue("production");
    await expect(page.getByRole("img", { name: /Requests by status/ })).toHaveAttribute("aria-label", /in the last 1 hour in production/);
    // Every range link names its range, so 24h stays 24h.
    await expect(ranges.getByRole("link", { name: "24h" })).toHaveAttribute("href", "/project/shop/traffic?range=24h&env=production");

    // Three days of data: the last 7 days.
    await ingested(new Date(Date.now() - 3 * 86_400_000).toISOString());
    await page.goto(PAGE);
    await expect(ranges.getByRole("link", { name: "7d" })).toHaveAttribute("aria-current", "page");

    // The last environment chosen is remembered for the project, "All environments" too.
    await env.selectOption("");
    await page.waitForURL((url) => url.searchParams.get("env") === "all");
    await page.goto(PAGE);
    await page.waitForURL((url) => url.searchParams.get("env") === "all");
    await expect(env).toHaveValue("");
    await expect(tiles(page)).toHaveText(["12,400", "3.0%", "413 ms", "0.91"]);
  } finally {
    await ingested(null);
  }
});

test("the range and environment travel with the rail (#992)", async ({ page }) => {
  await seed();
  await signIn(page, "/project/shop/traffic?range=7d&env=production");
  // The range picker sits in the page header, next to the title.
  await expect(page.locator("header.ph").getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "7d" })).toHaveAttribute("aria-current", "page");
  const views = page.getByRole("navigation", { name: "Pages" });
  await expect(views.getByRole("link", { name: "Errors" })).toHaveAttribute("href", "/project/shop/errors?range=7d&env=production");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Project settings" })).toHaveAttribute("href", "/project/shop/settings?range=7d&env=production");

  await views.getByRole("link", { name: "Errors" }).click();
  await page.waitForURL((url) => url.pathname === "/project/shop/errors");
  await expect(page.getByRole("heading", { level: 1, name: "Errors" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "7d" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("combobox", { name: "Environment" })).toHaveValue("production");
  await expect(views.getByRole("link", { name: "Performance" })).toHaveAttribute("href", "/project/shop/performance?range=7d&env=production");
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
  await page.goto(allEnvs(`${PAGE}?page=9`));
  await expect(pages).toContainText("Showing 26–30 of 30");
  // A narrower scope drops the page; one page of rows has no controls.
  await page.getByRole("combobox", { name: "Environment" }).selectOption("production");
  await page.waitForURL((url) => url.searchParams.get("env") === "production" && !url.searchParams.has("page"));
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(3);
  await expect(pages).toHaveCount(0);
});

test("sorts the endpoints table by any column, in the URL, with aria-sort (#1001)", async ({ page }) => {
  const many = [
    ...ENDPOINTS,
    { method: "GET", path: "/users", requests: 600, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 12, p95_ms: 90, apdex: 0.99 },
    { method: "GET", path: "/health", requests: 0, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, apdex: null },
  ];
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints: many } });
  await signIn(page, `${PAGE}?range=6h`);
  const table = endpointsTable(page);
  const paths = () => table.locator("tbody .tr-ep code");
  const header = (name: string) => table.getByRole("columnheader", { name, exact: true });

  // Busiest first by default, as the API lists them.
  await expect(header("Requests")).toHaveAttribute("aria-sort", "descending");
  await expect(header("p95")).not.toHaveAttribute("aria-sort", /./);
  await expect(paths()).toHaveText(["/orders/{id}", "/charge", "/users", "/health"]);

  // A column sorts largest first, then the other way; the scope stays in the URL.
  await header("p95").getByRole("link").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "p95" && url.searchParams.get("dir") === "desc" && url.searchParams.get("range") === "6h");
  await expect(header("p95")).toHaveAttribute("aria-sort", "descending");
  await expect(header("Requests")).not.toHaveAttribute("aria-sort", /./);
  await expect(paths()).toHaveText(["/charge", "/orders/{id}", "/users", "/health"]);
  await header("p95").getByRole("link").click();
  await page.waitForURL((url) => url.searchParams.get("dir") === "asc");
  await expect(header("p95")).toHaveAttribute("aria-sort", "ascending");
  await expect(paths()).toHaveText(["/health", "/users", "/orders/{id}", "/charge"]);

  // Apdex sorts worst first; endpoints without a score go last.
  await header("Apdex").getByRole("link").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "apdex");
  await expect(header("Apdex")).toHaveAttribute("aria-sort", "ascending");
  await expect(paths()).toHaveText(["/charge", "/orders/{id}", "/users", "/health"]);

  // Endpoint sorts A to Z; a sorted link survives a reload.
  await header("Endpoint").getByRole("link").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "endpoint");
  await page.reload();
  await expect(header("Endpoint")).toHaveAttribute("aria-sort", "ascending");
  await expect(paths()).toHaveText(["/charge", "/health", "/orders/{id}", "/users"]);

  const a11y = await new AxeBuilder({ page }).include("table.tr-table").analyze();
  expect(a11y.violations).toEqual([]);
});

test("sorts before paging and starts again at page 1 (#1001)", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ENDPOINTS[0], path: `/items/${String(i).padStart(2, "0")}`, requests: 1000 - i, p95_ms: 10 + i }));
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints: many } });
  await signIn(page, `${PAGE}?page=2`);
  await endpointsTable(page).getByRole("columnheader", { name: "p95", exact: true }).getByRole("link").click();
  await page.waitForURL((url) => url.searchParams.get("sort") === "p95" && !url.searchParams.has("page"));
  // The slowest of all 30 heads page 1, not the slowest of the first 25.
  await expect(endpointsTable(page).locator("tbody .tr-ep code").first()).toHaveText("/items/29");
});

test("collapses routes declared without traffic into one group under the table (#1003)", async ({ page }) => {
  const declared = (method: string, path: string) => ({ method, path, requests: 0, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, apdex: null, discovered_only: true });
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints: [...ENDPOINTS, declared("GET", "/health"), declared("DELETE", "/orders/{id}")] } });
  await signIn(page);
  // Only the endpoints with traffic are rows: no "0 / 0 ms / n/a" row reads like a fast endpoint.
  await expect(endpointsTable(page).locator("tbody tr")).toHaveCount(2);
  await expect(endpointsTable(page)).not.toContainText("/health");

  const group = page.locator("details.tr-declared");
  const summary = group.locator("summary");
  await expect(summary).toHaveText("2 declared routes without traffic");
  await expect(group).not.toHaveAttribute("open", /.*/);
  const list = page.getByRole("list", { name: "Declared routes without traffic" });
  await expect(list).toBeHidden();
  await summary.click();
  await expect(list.getByRole("link")).toHaveText(["GET /health", "DELETE /orders/{id}"]);
  await expect(group).toContainText("Your apps declared these routes, but none was called in the last 24 hours.");
  // The drill-down keeps the page's scope (D4 of #963): range and "All environments" travel along.
  await expect(list.getByRole("link", { name: "GET /health" })).toHaveAttribute("href", "/project/shop/endpoints/GET/%2Fhealth?range=24h&env=all");

  const a11y = await new AxeBuilder({ page }).include(".tr-card--table").analyze();
  expect(a11y.violations).toEqual([]);
});

test("searches the endpoints table by path, in the URL, keeping the scope and sort (#1003)", async ({ page }) => {
  const declared = { method: "GET", path: "/orders/export", requests: 0, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, apdex: null, discovered_only: true };
  const many = [...ENDPOINTS, { method: "GET", path: "/users", requests: 600, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 12, p95_ms: 90, apdex: 0.99 }, declared];
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints: many } });
  await signIn(page, `${PAGE}?range=6h&sort=p95&dir=desc`);
  const paths = () => endpointsTable(page).locator("tbody .tr-ep code");
  await expect(paths()).toHaveText(["/charge", "/orders/{id}", "/users"]);

  const search = page.getByRole("searchbox", { name: "Search endpoint paths" });
  await search.fill("ORDERS");
  await search.press("Enter");
  await page.waitForURL((url) => url.searchParams.get("q") === "ORDERS" && url.searchParams.get("range") === "6h" && url.searchParams.get("sort") === "p95" && url.searchParams.get("env") === "all");
  await expect(search).toHaveValue("ORDERS");
  await expect(paths()).toHaveText(["/orders/{id}"]);
  // The declared routes are searched too, and their group opens to show the matches.
  const group = page.locator("details.tr-declared");
  await expect(group.locator("summary")).toHaveText("1 declared route without traffic");
  await expect(page.getByRole("list", { name: "Declared routes without traffic" }).getByRole("link")).toHaveText(["GET /orders/export"]);

  // No match says so; Clear takes the search back out, keeping the rest.
  await search.fill("/nothing");
  const form = page.getByRole("search", { name: "Endpoints" });
  await form.getByRole("button", { name: "Search" }).click();
  await page.waitForURL((url) => url.searchParams.get("q") === "/nothing" && url.searchParams.get("env") === "all");
  await expect(page.getByRole("status").filter({ hasText: "No endpoints with requests match “/nothing” in the last 6 hours." })).toBeVisible();
  await expect(endpointsTable(page)).toHaveCount(0);
  await expect(group).toHaveCount(0);
  await form.getByRole("link", { name: "Clear" }).click();
  await page.waitForURL((url) => !url.searchParams.has("q") && url.searchParams.get("sort") === "p95" && url.searchParams.get("env") === "all");
  await expect(paths()).toHaveText(["/charge", "/orders/{id}", "/users"]);

  const a11y = await new AxeBuilder({ page }).include(".tr-card--table").analyze();
  expect(a11y.violations).toEqual([]);
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
  await page.goto(allEnvs("/project/shop/endpoints/POST/%2Fcharge"));
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

// The app filter and App column (#976) -------------------------------------------------------

test("filters by app, All apps by default, with an App column whose rows open scoped to their app", async ({ page }) => {
  const shop = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
  const billing = "8a2d3b4c-5e6f-4a71-9bac-1d2e3f4a5b6c";
  const billingSummary = { ...SUMMARY, requests: 4200, client_errors: 20, server_errors: 60, p95_ms: 1820, apdex: 0.61 };
  await fetch(`${IDENTITY}/__fake/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apps: [{ id: shop, slug: "shop", name: "Shop" }, { id: billing, slug: "billing", name: "Billing", traffic: { summary: billingSummary, points: POINTS } }] }),
  });
  const endpoints = [
    { ...ENDPOINTS[0], app_id: shop },
    { ...ENDPOINTS[1], app_id: billing },
  ];
  await seed({ "": { summary: SUMMARY, points: POINTS, endpoints } });
  await signIn(page);

  const app = page.getByRole("combobox", { name: "App" });
  await expect(app).toHaveValue("");
  await expect(app.getByRole("option")).toHaveText(["All apps", "Shop", "Billing"]);
  await expect(tiles(page).first()).toHaveText("12,400");
  await expect(endpointsTable(page).getByRole("columnheader")).toHaveText(["Endpoint", "App", "Requests", "4xx", "5xx", "p50", "p95", "Apdex", "Settings"]);
  const rows = endpointsTable(page).locator("tbody tr");
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("Shop");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("Billing");
  // A row is one app's endpoint: its link and its settings menu are that app's.
  await expect(endpointsTable(page).getByRole("link", { name: "POST /charge" })).toHaveAttribute("href", `/project/shop/endpoints/POST/%2Fcharge?range=24h&env=all&app=${billing}`);
  await endpointsTable(page).getByRole("button", { name: "Settings for POST /charge" }).click();
  await expect(rowMenu(page, "POST /charge").getByRole("menuitemradio", { name: "Billing" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await app.selectOption({ label: "Billing" });
  await page.waitForURL(new RegExp(`app=${billing}`));
  await expect(tiles(page).first()).toHaveText("4,200");
  await expect(page.getByRole("img", { name: /Requests by status/ })).toHaveAttribute("aria-label", /4,200 requests in the last 24 hours for Billing/);
  // One app in scope: its rows only, and no App column to repeat it.
  await expect(endpointsTable(page).getByRole("columnheader")).toHaveText(["Endpoint", "Requests", "4xx", "5xx", "p50", "p95", "Apdex", "Settings"]);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole("cell").first()).toHaveText("POST /charge");
  // The range links keep the app.
  await expect(page.getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "7d" })).toHaveAttribute("href", `/project/shop/traffic?range=7d&env=all&app=${billing}`);

  const a11y = await new AxeBuilder({ page }).include(".tr").analyze();
  expect(a11y.violations).toEqual([]);
});
