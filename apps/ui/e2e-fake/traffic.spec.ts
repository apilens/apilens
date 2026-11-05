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

test.afterEach(async () => {
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
  await expect(summary.locator("svg.tr-spark polyline")).toHaveCount(3);

  const status = page.getByRole("img", { name: /Requests by status/ });
  await expect(status).toHaveAttribute("aria-label", /12,400 requests in the last 24 hours: 310 4xx and 62 5xx/);
  await expect(page.getByRole("list", { name: "Requests by status legend" }).getByRole("listitem")).toHaveText(["Successful", "4xx", "5xx"]);
  // One hover target per bucket, its values in the tooltip; 4xx and 5xx differ in color too.
  await expect(status.locator(".tr-hit")).toHaveCount(4);
  await expect(status.locator(".tr-hit title").nth(1)).toHaveText(/Successful: 3,288\n4xx: 100\n5xx: 12/);
  const fill = (cls: string) => status.locator(cls).first().evaluate((el) => getComputedStyle(el).fill);
  expect(await fill(".tr-fill-4xx")).not.toBe(await fill(".tr-fill-5xx"));
  await expect(page.getByRole("img", { name: /Response time/ })).toHaveAttribute("aria-label", /p95 of 413 ms/);

  await expect(endpointsTable(page).getByRole("columnheader")).toHaveText(["Endpoint", "Requests", "4xx", "5xx", "p50", "p95", "Apdex"]);
  const rows = endpointsTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole("cell")).toHaveText(["GET /orders/{id}", "8,200", "290 (3.5%)", "2 (<0.1%)", "31 ms", "220 ms", "0.97"]);
  await expect(rows.nth(1).getByRole("cell")).toHaveText(["POST /charge", "4,200", "20 (0.5%)", "60 (1.4%)", "410 ms", "1.82 s", "0.61"]);

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
});
