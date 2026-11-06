// Performance (#595) against the fake identity (e2e-fake/fake-identity.ts), which plays the query
// role: `GET /traffic/latency` answers what `/__fake/performance` seeded, its Apdex scored over the
// seeded response times against the app's threshold (`GET|PUT /apps/{id}/settings`), so saving a
// threshold changes the next read; the page's `/traffic/endpoints` read answers the same seed's
// endpoints. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/performance";

const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();

const LATENCY = {
  summary: { requests: 12_400, avg_ms: 48.2, max_ms: 2310, p50_ms: 31, p75_ms: 64, p90_ms: 140, p95_ms: 412.6, p99_ms: 1240 },
  points: [
    { ts: bucket(0), requests: 3000, p50_ms: 30, p75_ms: 60, p95_ms: 380 },
    { ts: bucket(1), requests: 3400, p50_ms: 33, p75_ms: 70, p95_ms: 420 },
    { ts: bucket(2), requests: 2600, p50_ms: 29, p75_ms: 58, p95_ms: 610 },
    { ts: bucket(3), requests: 3400, p50_ms: 31, p75_ms: 66, p95_ms: 300 },
  ],
  histogram: [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].map((from, i, all) => ({
    from_ms: from,
    ...(i < all.length - 1 ? { to_ms: all[i + 1] } : {}),
    count: [0, 4, 30, 400, 2800, 4600, 2900, 900, 600, 120, 40, 6, 0, 0][i],
  })),
};
// Satisfied within 500 ms: 100, 300; tolerating within 2 s: 900; frustrated: 3000. Apdex 0.63.
const SAMPLES = [100, 300, 900, 3000];

const ENDPOINTS = [
  { method: "GET", path: "/orders/{id}", requests: 8200, client_errors: 290, server_errors: 2, error_rate: 0.035, p50_ms: 31, p95_ms: 220.4, apdex: 0.97 },
  { method: "POST", path: "/charge", requests: 4200, client_errors: 20, server_errors: 60, error_rate: 0.019, p50_ms: 410, p95_ms: 1820, apdex: 0.61 },
  { method: "GET", path: "/health", requests: 0, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, apdex: null, discovered_only: true },
];

async function post(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

// The endpoints and the outage come with the performance seed, never `/__fake/traffic` or
// `/__fake/query-down`, which the Traffic and endpoint tests may be using at the same time.
async function seed(on = true, down = false) {
  await post("/__fake/performance", on ? { project: "shop", latency: LATENCY, samples_ms: SAMPLES, endpoints: ENDPOINTS, down } : { project: "shop" });
}

async function signIn(page: Page, next = PAGE, seeds: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...seeds }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const tiles = (page: Page) => page.locator("dl.pf-tiles");
const apdexValue = (page: Page) => tiles(page).locator(".pf-apdex .tr-tile__value");

/** The hover tooltip of chart `name` at bucket `i` (0-based), reached with the keyboard. */
async function tipAt(page: Page, name: RegExp, i: number) {
  const box = page.getByRole("group", { name });
  await box.focus();
  await page.keyboard.press("Home");
  for (let k = 0; k < i; k++) await page.keyboard.press("ArrowRight");
  return box.locator(".ct-tip");
}

test.afterEach(async () => {
  await seed(false);
});

test("shows percentile tiles and trend, the Apdex gauge, the histogram and the endpoints by p95", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Performance" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Performance" })).toHaveAttribute("aria-current", "page");

  await expect(tiles(page).locator("dt")).toHaveText(["p50 response time", "p75 response time", "p95 response time", /^Apdex/]);
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["31 ms", "64 ms", "413 ms", "0.63"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["average 48 ms", "p90 140 ms", "p99 1.24 s, slowest 2.31 s", "Poor"]);
  await expect(tiles(page).locator(".tr-spark polyline")).toHaveCount(3);
  // Each tile sparkline reads its points on hover or with the arrow keys.
  const spark = await tipAt(page, /^p95 in the last 24 hours/, 2);
  await expect(spark.locator("dd")).toHaveText(["610 ms"]);

  // The gauge is a meter with a text value; the marker sits at the score.
  const gauge = page.getByRole("meter", { name: "Apdex" });
  await expect(gauge).toHaveAttribute("aria-valuetext", "0.63, Poor");
  await expect(gauge.locator(".pf-gauge__mark")).toHaveAttribute("style", /left:\s?63%/);

  // How Apdex is scored, on focus of the info button; Escape hides it.
  const help = page.getByRole("button", { name: "How Apdex is scored" });
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeHidden();
  await help.focus();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Apdex = (satisfied + tolerating / 2) / requests.");
  await expect(tip).toContainText("else its app’s (Shop: 500 ms), else 500 ms.");
  await expect(help).toHaveAccessibleDescription(/Satisfied: answered within T/);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();

  const trend = page.getByRole("img", { name: /Response time percentiles/ });
  await expect(trend).toHaveAttribute("aria-label", /p50 31 ms, p75 64 ms and p95 413 ms in the last 24 hours/);
  await expect(page.getByRole("list", { name: "Response time percentiles legend" }).getByRole("listitem")).toHaveText(["p50", "p75", "p95"]);
  await expect(trend.locator("path[data-series]")).toHaveCount(3);
  const point = await tipAt(page, /^Response time percentiles\. Use the arrow keys/, 2);
  await expect(point.locator("dt")).toHaveText(["p50", "p75", "p95"]);
  await expect(point.locator("dd")).toHaveText(["29 ms", "58 ms", "610 ms"]);

  const hist = page.getByRole("img", { name: /Response time histogram/ });
  await expect(hist.locator(".tr-hit")).toHaveCount(14);
  const bar = await tipAt(page, /^Response time histogram\. Use the arrow keys/, 5);
  await expect(bar.locator(".ct-tip__title")).toHaveText("20–50 ms");
  await expect(bar.locator("dd").first()).toHaveText("4,600");

  // Slowest p95 first; routes without traffic have no response times to rank.
  const table = page.getByRole("table", { name: "Endpoints by p95 response time" });
  await expect(table.getByRole("columnheader")).toHaveText(["Endpoint", "Requests", "p50", "p95", "Apdex"]);
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole("cell")).toHaveText(["POST /charge", "4,200", "410 ms", "1.82 s", "0.61"]);
  await expect(rows.nth(1).getByRole("cell")).toHaveText(["GET /orders/{id}", "8,200", "31 ms", "220 ms", "0.97"]);
  // Each endpoint opens its Response times tab, where its own threshold is set.
  await expect(rows.nth(0).getByRole("link")).toHaveAttribute("href", "/shop/endpoints/POST/%2Fcharge?tab=latency");

  const a11y = await new AxeBuilder({ page }).include(".pf").analyze();
  expect(a11y.violations).toEqual([]);
});

test("saving the app's response time threshold reads the Apdex again", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(apdexValue(page)).toHaveText("0.63");

  await page.getByRole("button", { name: "App settings" }).click();
  const dialog = page.getByRole("dialog", { name: "App settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("For app Shop");
  const threshold = dialog.getByRole("textbox", { name: "Response time threshold (ms)" });
  await expect(threshold).toHaveValue("");
  await expect(threshold).toHaveAttribute("placeholder", "500 (default)");

  await threshold.fill("1s");
  await dialog.getByRole("button", { name: "Save threshold" }).click();
  await expect(dialog.getByText("Enter whole milliseconds from 1 to 600,000")).toBeVisible();
  await expect(threshold).toHaveAttribute("aria-invalid", "true");

  // T = 1000 ms: 100, 300 and 900 satisfied, 3000 tolerating. Apdex (3 + 0.5) / 4.
  await threshold.fill("1000");
  await dialog.getByRole("button", { name: "Save threshold" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Threshold saved: 1000 ms for Shop." })).toBeVisible();
  await expect(apdexValue(page)).toHaveText("0.88");
  await expect(page.getByRole("meter", { name: "Apdex" })).toHaveAttribute("aria-valuetext", "0.88, Good");
  // Hidden until hovered or focused, the explanation names the new threshold.
  await expect(page.locator("[role=tooltip]")).toContainText("(Shop: 1000 ms)");

  // Reopened, the dialog shows what was saved; clearing it goes back to 500 ms.
  await page.getByRole("button", { name: "App settings" }).click();
  await expect(threshold).toHaveValue("1000");
  await threshold.fill("");
  await dialog.getByRole("button", { name: "Save threshold" }).click();
  await expect(dialog).toBeHidden();
  await expect(apdexValue(page)).toHaveText("0.63");
});

test("the app threshold is read-only without capture.manage", async ({ page }) => {
  await seed();
  await signIn(page, PAGE, { capabilities: ["project.read"] });
  await page.getByRole("button", { name: "App settings" }).click();
  const dialog = page.getByRole("dialog", { name: "App settings" });
  await expect(dialog.getByText("Only project admins can change it.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Response time threshold (ms)" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save threshold" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("keeps range and environment in the URL", async ({ page }) => {
  await seed();
  await signIn(page);
  await page.getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "1h" }).click();
  await page.waitForURL((url) => url.search === "?range=1h");
  await page.getByLabel("Environment").selectOption("production");
  await page.waitForURL((url) => url.search === "?range=1h&env=production");
  await expect(page.getByRole("img", { name: /Response time percentiles/ })).toHaveAttribute("aria-label", /in the last 1 hour in production/);
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page);
  await expect(page.getByRole("table", { name: "Endpoints by p95 response time" }).locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "How Apdex is scored" }).focus();
  await expect(page.locator("[role=tooltip]")).toBeVisible();
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("says so when there were no requests, and when the report cannot load", async ({ page }) => {
  await signIn(page, `${PAGE}?range=1h`);
  await expect(page.getByRole("status").filter({ hasText: "No requests in the last 1 hour." })).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);

  await seed(true, true);
  await page.goto(PAGE);
  await expect(page.getByRole("alert").filter({ hasText: "We couldn’t load response times just now." })).toBeVisible();
  await expect(page.getByRole("alert").getByRole("link", { name: "Try again" }).first()).toHaveAttribute("href", PAGE);
});
