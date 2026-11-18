// Drill-down from analytics to Explore (#977, decision D3 of #963) against the fake identity
// (e2e-fake/fake-identity.ts): the Traffic table's 4xx, 5xx and p95 cells, its status-chart bars,
// Endpoint detail's View requests, the Errors status rows and the Performance p95 tile each open
// Explore with the matching filters, carrying the range, environment and app. Explore answers what
// `/__fake/requests` seeded, filtered by method, route template, status, app and time window as
// the API does, so a route template from analytics finds its requests. No email is sent here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SHOP_APP = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const BILLING_APP = "8a2d3b4c-5e6f-4a71-9bac-1d2e3f4a5b6c";

const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

async function post(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

// Explore's log: requests to a route template (raw URLs differ) and to another endpoint.
function row(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `req_${i}`,
    timestamp: ago(200 + i * 60),
    app_id: SHOP_APP,
    method: "GET",
    path: "/orders/{id}",
    raw_path: `/orders/${1000 + i}`,
    status_code: 200,
    response_time_ms: 42,
    request_size: 0,
    response_size: 1234,
    environment: "production",
    ip_address: "203.0.113.7",
    consumer_id: "c_acme",
    consumer_name: "Acme Corp",
    consumer_group: "",
    sampled: true,
    trace_id: `t${i}`,
    ...extra,
  };
}
const ROWS = [
  row(0),
  row(1, { status_code: 404 }),
  row(2, { status_code: 503, response_time_ms: 900 }),
  row(3, { method: "POST", path: "/charge", raw_path: "/charge", status_code: 404, app_id: BILLING_APP }),
  row(4, { status_code: 404, consumer_id: "c_beta", consumer_name: "" }),
];

const grid = (page: Page) => page.getByRole("grid", { name: "Requests" });
/** The raw URLs the Explore log lists, in order. */
const loggedPaths = (page: Page) => grid(page).locator(".ex-spacer [role=row] [role=gridcell]:nth-child(4)");

/** The page's search params as an object, for comparing a link's filters. */
const paramsOf = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

test.beforeEach(async () => {
  await post("/__fake/requests", { project: "shop", rows: ROWS });
});

test.afterEach(async () => {
  await post("/__fake/requests", { project: "shop", rows: null });
  await post("/__fake/traffic", { project: "shop", envs: {} });
  await post("/__fake/apps", { apps: [] });
  await post("/__fake/endpoint", { project: "shop", method: "GET", path: "/orders/{id}", tabs: {} });
  await post("/__fake/errors", { project: "shop", buckets: [], requests: [], rows: [] });
  await post("/__fake/performance", { project: "shop" });
});

test("Traffic: 4xx, 5xx and p95 cells open the row's requests in Explore, in the page's range, environment and app", async ({ page }) => {
  await post("/__fake/apps", { apps: [{ id: SHOP_APP, slug: "shop", name: "Shop" }, { id: BILLING_APP, slug: "billing", name: "Billing" }] });
  const points = [0, 1, 2, 3].map((i) => ({ ts: bucket(i), requests: 1000, client_errors: 10, server_errors: 2, p95_ms: 300 }));
  const summary = { from: "", to: "", requests: 4000, client_errors: 40, server_errors: 8, error_rate: 0.012, p50_ms: 30, p95_ms: 300, p99_ms: 900, requests_per_minute: 2.7, apdex: 0.95 };
  const endpoints = [
    { method: "GET", path: "/orders/{id}", app_id: SHOP_APP, requests: 3000, client_errors: 30, server_errors: 6, error_rate: 0.012, p50_ms: 31, p95_ms: 220.4, apdex: 0.97 },
    { method: "POST", path: "/charge", app_id: BILLING_APP, requests: 1000, client_errors: 10, server_errors: 0, error_rate: 0.01, p50_ms: 400, p95_ms: 1820, apdex: 0.6 },
  ];
  await post("/__fake/traffic", { project: "shop", envs: { production: { summary, points, endpoints } } });
  await signIn(page, "/project/shop/traffic?range=6h&env=production");

  const table = page.getByRole("table", { name: "Endpoints" });
  const orders = table.locator("tbody tr").filter({ hasText: "/orders/{id}" });
  const scope = { range: "6h", env: "production", app: SHOP_APP, method: "GET", path: "/orders/{id}" };
  await expect(orders.getByRole("link", { name: "30 4xx responses in Explore" })).toHaveAttribute("href", /\/shop\/explore\?/);
  expect(paramsOf((await orders.getByRole("link", { name: /4xx responses/ }).getAttribute("href")) ?? "")).toEqual({ ...scope, status: "4xx" });
  expect(paramsOf((await orders.getByRole("link", { name: /5xx responses/ }).getAttribute("href")) ?? "")).toEqual({ ...scope, status: "5xx" });
  expect(paramsOf((await orders.getByRole("link", { name: /^p95 220 ms/ }).getAttribute("href")) ?? "")).toEqual({ ...scope, latency_min: "220" });
  // A row of another app opens that app's requests.
  const charge = table.locator("tbody tr").filter({ hasText: "/charge" });
  expect(paramsOf((await charge.getByRole("link", { name: /4xx responses/ }).getAttribute("href")) ?? "")).toEqual({ ...scope, app: BILLING_APP, method: "POST", path: "/charge", status: "4xx" });
  // No 5xx: nothing to open.
  await expect(charge.getByRole("link", { name: /5xx responses/ })).toHaveCount(0);

  // The route template matches in Explore: the 4xx of every /orders/<id> of Shop, not /charge.
  await orders.getByRole("link", { name: /4xx responses/ }).click();
  await page.waitForURL(/\/shop\/explore\?/);
  await expect(loggedPaths(page)).toHaveText(["/orders/1001", "/orders/1004"]);
});

test("Traffic: a status-chart bar opens its bucket's requests in Explore, by click or Enter", async ({ page }) => {
  const points = [0, 1, 2, 3].map((i) => ({ ts: bucket(i), requests: 1000, client_errors: 10, server_errors: 2, p95_ms: 300 }));
  const summary = { from: "", to: "", requests: 4000, client_errors: 40, server_errors: 8, error_rate: 0.012, p50_ms: 30, p95_ms: 300, p99_ms: 900, requests_per_minute: 2.7, apdex: 0.95 };
  await post("/__fake/traffic", { project: "shop", envs: { production: { summary, points, endpoints: [] } } });
  await signIn(page, "/project/shop/traffic?range=24h&env=production");

  const chart = page.getByRole("group", { name: /Requests by status.*Press Enter to see a bucket’s requests in Explore/ });
  await chart.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(chart.locator(".ct-tip")).toContainText("Click to see these requests in Explore");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/shop\/explore\?/);
  expect(paramsOf(page.url())).toEqual({ range: "24h", env: "production", from: "2026-11-05T10:15:00Z", to: "2026-11-05T10:30:00Z" });

  await page.goBack();
  const box = page.getByRole("group", { name: /Requests by status/ });
  const r = await box.boundingBox();
  if (!r) throw new Error("no chart");
  // The last of four buckets: as wide as the one before it.
  await page.mouse.move(r.x + r.width * 0.9, r.y + r.height / 2);
  // The page is rendered again after Back: click once hovering shows the bucket's tooltip, so the
  // click lands on a chart that handles it (a click before then went nowhere, #1040).
  await expect(box.locator(".ct-tip")).toContainText("Click to see these requests in Explore");
  await page.mouse.click(r.x + r.width * 0.9, r.y + r.height / 2);
  await page.waitForURL(/\/shop\/explore\?/);
  expect(paramsOf(page.url())).toEqual({ range: "24h", env: "production", from: "2026-11-05T10:45:00Z", to: "2026-11-05T11:00:00Z" });
});

test("Endpoint detail: View requests opens the endpoint in Explore with its scope", async ({ page }) => {
  const points = [0, 1].map((i) => ({ ts: bucket(i), requests: 10, successful: 8, client_errors: 2, server_errors: 0 }));
  await post("/__fake/endpoint", {
    project: "shop",
    method: "GET",
    path: "/orders/{id}",
    tabs: { requests: { summary: { requests: 20, successful: 16, client_errors: 4, server_errors: 0, requests_per_minute: 0.1 }, points, consumers: [] } },
  });
  await signIn(page, "/project/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=6h&env=production&status=4xx&consumer=c_acme");

  const view = page.getByRole("link", { name: "View requests" });
  expect(paramsOf((await view.getAttribute("href")) ?? "")).toEqual({ range: "6h", env: "production", method: "GET", status: "4xx", path: "/orders/{id}", consumer_id: "c_acme" });
  // The status chart's bars open their bucket in the same scope.
  await expect(page.getByRole("group", { name: /Requests by status.*Press Enter/ })).toBeVisible();

  await view.click();
  await page.waitForURL(/\/shop\/explore\?/);
  await expect(loggedPaths(page)).toHaveText(["/orders/1001"]);
});

test("Errors: a status code's responses open in Explore", async ({ page }) => {
  const buckets = [0, 1].map(bucket);
  await post("/__fake/errors", {
    project: "shop",
    buckets,
    requests: [1000, 1000],
    rows: [
      { method: "GET", path: "/orders/{id}", status_code: 404, bucket: 0, count: 12 },
      { method: "GET", path: "/orders/{id}", status_code: 503, bucket: 1, count: 3 },
    ],
  });
  await signIn(page, "/project/shop/errors?range=24h&env=all");

  const statuses = page.getByRole("table", { name: "Error status codes" });
  const link = statuses.getByRole("link", { name: "12 404 responses in Explore" });
  expect(paramsOf((await link.getAttribute("href")) ?? "")).toEqual({ range: "24h", status: "404" });
  await link.click();
  await page.waitForURL(/\/shop\/explore\?/);
  await expect(loggedPaths(page)).toHaveText(["/orders/1001", "/charge", "/orders/1004"]);
});

test("Performance: the p95 tile opens the requests at p95 or slower", async ({ page }) => {
  const latency = {
    summary: { requests: 100, avg_ms: 48, max_ms: 900, p50_ms: 31, p75_ms: 64, p90_ms: 140, p95_ms: 412.6, p99_ms: 800 },
    points: [0, 1].map((i) => ({ ts: bucket(i), requests: 50, p50_ms: 30, p75_ms: 60, p95_ms: 400 })),
    histogram: [],
  };
  await post("/__fake/apps", { apps: [{ id: SHOP_APP, slug: "shop", name: "Shop" }, { id: BILLING_APP, slug: "billing", name: "Billing" }] });
  await post("/__fake/performance", { project: "shop", latency, samples_ms: [100], endpoints: [], slowest: [] });
  await signIn(page, `/project/shop/performance?range=7d&env=production&app=${SHOP_APP}`);

  const p95 = page.getByRole("link", { name: /^p95 413 ms: requests at p95 or slower in Explore$/ });
  expect(paramsOf((await p95.getAttribute("href")) ?? "")).toEqual({ range: "7d", env: "production", app: SHOP_APP, latency_min: "412" });
});
