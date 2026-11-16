// Endpoint detail (#593) against the fake identity (e2e-fake/fake-identity.ts), which plays the
// query role: `GET /endpoints/{method}/{path}/{requests|errors|latency|transfer}` answer what
// `/__fake/endpoint` seeded and log every read, so each test can tell that only the open tab read
// its data; the endpoint settings are kept per app. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/endpoints/GET/%2Forders%2F%7Bid%7D";

const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();
const ts = (i: number) => ({ ts: bucket(i) });

/** The hover tooltip of chart `name` at bucket `i` (0-based), reached with the keyboard. */
async function tipAt(page: Page, name: RegExp, i: number) {
  const box = page.getByRole("group", { name });
  await box.focus();
  await page.keyboard.press("Home");
  for (let k = 0; k < i; k++) await page.keyboard.press("ArrowRight");
  return box.locator(".ct-tip");
}

const REQUESTS = {
  summary: { requests: 8200, successful: 7908, client_errors: 290, server_errors: 2, requests_per_minute: 5.69 },
  points: [
    { ...ts(0), requests: 2000, successful: 1900, client_errors: 100, server_errors: 0 },
    { ...ts(1), requests: 2200, successful: 2110, client_errors: 88, server_errors: 2 },
    { ...ts(2), requests: 1800, successful: 1750, client_errors: 50, server_errors: 0 },
    { ...ts(3), requests: 2200, successful: 2148, client_errors: 52, server_errors: 0 },
  ],
  consumers: [
    { consumer_id: "c_acme", consumer_name: "Acme Corp", requests: 5100, successful: 5000, client_errors: 98, server_errors: 2 },
    { consumer_id: "c_globex", consumer_name: "", requests: 1200, successful: 1100, client_errors: 100, server_errors: 0 },
  ],
};

const ERRORS = {
  summary: { requests: 8200, client_errors: 290, server_errors: 2, client_error_rate: 0.0354, server_error_rate: 0.000244 },
  points: [
    { ...ts(0), requests: 2000, client_errors: 100, server_errors: 0, client_error_rate: 0.05, server_error_rate: 0 },
    { ...ts(1), requests: 2200, client_errors: 88, server_errors: 2, client_error_rate: 0.04, server_error_rate: 0.0009 },
    { ...ts(2), requests: 1800, client_errors: 50, server_errors: 0, client_error_rate: 0.0278, server_error_rate: 0 },
  ],
  statuses: [
    { status_code: 404, count: 210, share: 0.0256, consumers: 4, last_seen: "2026-11-05T10:44:00Z" },
    { status_code: 422, count: 80, share: 0.0098, consumers: 2, last_seen: "2026-11-05T10:40:00Z" },
    { status_code: 500, count: 2, share: 0.000244, consumers: 1, last_seen: "2026-11-05T10:20:00Z" },
  ],
  validation_errors: [{ loc: "query.limit", msg: "Input should be less than or equal to 100", type: "less_than_equal", count: 80, consumers: 2, last_seen: "2026-11-05T10:40:00Z" }],
  exceptions: [
    {
      exception_type: "KeyError",
      message: "'currency'",
      count: 2,
      consumers: 1,
      first_seen: "2026-11-05T10:05:00Z",
      last_seen: "2026-11-05T10:20:00Z",
      stack_trace: 'Traceback (most recent call last):\n  File "orders.py", line 42, in get_order\n    total = order["currency"]\nKeyError: \'currency\'',
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  ],
};

const LATENCY = {
  summary: { requests: 8200, avg_ms: 48.2, max_ms: 2310, p50_ms: 31, p75_ms: 64, p90_ms: 140, p95_ms: 220.4, p99_ms: 980, apdex: 0.97 },
  points: [
    { ...ts(0), requests: 2000, p50_ms: 30, p75_ms: 60, p95_ms: 200 },
    { ...ts(1), requests: 2200, p50_ms: 33, p75_ms: 70, p95_ms: 260 },
    { ...ts(2), requests: 1800, p50_ms: 29, p75_ms: 58, p95_ms: 190 },
  ],
  histogram: [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].map((from, i, all) => ({
    from_ms: from,
    ...(i < all.length - 1 ? { to_ms: all[i + 1] } : {}),
    count: [0, 4, 30, 400, 1800, 2600, 1900, 900, 400, 120, 40, 6, 0, 0][i],
  })),
};

const SIZE_EDGES = [0, 1, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304];
const sizes = (counts: number[]) => SIZE_EDGES.map((from, i) => ({ from_bytes: from, ...(i < SIZE_EDGES.length - 1 ? { to_bytes: SIZE_EDGES[i + 1] } : {}), count: counts[i] }));

const TRANSFER = {
  summary: { requests: 8200, request_bytes: 1_572_864, response_bytes: 23_068_672, avg_request_bytes: 192, avg_response_bytes: 2813 },
  points: [
    { ...ts(0), requests: 2000, request_bytes: 400_000, response_bytes: 5_600_000 },
    { ...ts(1), requests: 2200, request_bytes: 420_000, response_bytes: 6_200_000 },
    { ...ts(2), requests: 1800, request_bytes: 350_000, response_bytes: 5_100_000 },
    { ...ts(3), requests: 2200, request_bytes: 402_864, response_bytes: 6_168_672 },
  ],
  request_size_histogram: sizes([6000, 2100, 100, 0, 0, 0, 0, 0, 0, 0]),
  response_size_histogram: sizes([0, 200, 1500, 5800, 700, 0, 0, 0, 0, 0]),
};

async function seed(tabs: Record<string, unknown> = { requests: REQUESTS, errors: ERRORS, latency: LATENCY, transfer: TRANSFER }) {
  const res = await fetch(`${IDENTITY}/__fake/endpoint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", method: "GET", path: "/orders/{id}", tabs }),
  });
  expect(res.status).toBe(204);
}

/** The endpoint reads the page made since the last seed. */
async function reads(): Promise<{ tab: string; method: string; path: string; query: Record<string, string> }[]> {
  const res = await fetch(`${IDENTITY}/__fake/endpoint-reads`);
  const { reads: all } = (await res.json()) as { reads: { tab: string; method: string; path: string; query: Record<string, string> }[] };
  // Other spec files may open other endpoints on the same fake meanwhile.
  return all.filter((r) => r.method === "GET" && r.path === "/orders/{id}");
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", down }),
  });
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

const tiles = (page: Page) => page.locator("dl.ep-tiles");
const tabs = (page: Page) => page.getByRole("navigation", { name: "Endpoint views" });

test.afterEach(async () => {
  await queryDown(false);
  await seed({});
});

test("Requests tab: locked scope, tiles, status chart and top consumers, reading only its own data", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GET /orders/{id}");
  const scope = page.getByRole("definition");
  await expect(page.locator("dl.ep-locked dt")).toHaveText(["Method", "Path", "App"]);
  await expect(page.locator("dl.ep-locked dd")).toHaveText(["GET", "/orders/{id}", "Shop"]);
  await expect(scope.first()).toBeVisible();
  await expect(tabs(page).getByRole("link")).toHaveText(["Requests", "Errors", "Response times", "Data transferred"]);
  await expect(tabs(page).getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");

  await expect(tiles(page).locator("dt")).toHaveText(["Requests", "Successful", "Client errors (4xx)", "Server errors (5xx)"]);
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["8,200", "7,908", "290", "2"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["5.7 per minute", "96.4% of requests", "3.5% of requests", "<0.1% of requests"]);
  const chart = page.getByRole("img", { name: /Requests by status/ });
  await expect(chart).toHaveAttribute("aria-label", /8,200 requests in the last 24 hours: 290 4xx and 2 5xx/);
  await expect(chart.locator(".tr-hit")).toHaveCount(4);
  await expect(chart).toHaveAttribute("data-measured", /^\d+$/);

  const consumers = page.getByRole("table", { name: "Top consumers" });
  await expect(consumers.getByRole("columnheader")).toHaveText(["Consumer", "Requests", "Successful", "4xx", "5xx"]);
  await expect(consumers.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["Acme Corp", "5,100", "5,000", "98", "2"]);
  // A consumer without a name shows its id.
  await expect(consumers.locator("tbody tr").nth(1).getByRole("cell").first()).toHaveText("c_globex");

  // Lazy: the page read the Requests tab only.
  expect((await reads()).map((r) => r.tab)).toEqual(["requests"]);

  const a11y = await new AxeBuilder({ page }).include(".ep").analyze();
  expect(a11y.violations).toEqual([]);

  // A consumer row narrows the page to that consumer, kept in the URL and sent to the read.
  await consumers.getByRole("link", { name: "Acme Corp" }).click();
  await page.waitForURL(/consumer=c_acme/);
  await expect(page.locator(".ep-chip")).toContainText("c_acme");
  expect((await reads()).at(-1)).toEqual({ tab: "requests", method: "GET", path: "/orders/{id}", query: { range: "24h", consumer: "c_acme" } });
  await page.getByRole("link", { name: "Clear consumer c_acme" }).click();
  await page.waitForURL((url) => !url.search.includes("consumer"));
});

test("Errors tab: error rates, status codes, validation errors and server exceptions with the stack trace", async ({ page }) => {
  await seed();
  await signIn(page);
  await tabs(page).getByRole("link", { name: "Errors" }).click();
  await page.waitForURL(/tab=errors/);
  await expect(tabs(page).getByRole("link", { name: "Errors" })).toHaveAttribute("aria-current", "page");

  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["8,200", "3.5%", "<0.1%", "None"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["in the last 24 hours", "290 4xx", "2 5xx", "every 4xx and 5xx counts"]);
  const chart = page.getByRole("img", { name: /Error rate/ });
  await expect(page.getByRole("list", { name: "Error rate legend" }).getByRole("listitem")).toHaveText(["4xx rate", "5xx rate"]);
  await expect(chart.locator("path.ep-line")).toHaveCount(2);
  const rate = await tipAt(page, /^Error rate\. Use the arrow keys/, 1);
  await expect(rate.locator("dd")).toHaveText(["4%", "<0.1%"]);

  const statuses = page.getByRole("table", { name: "Error status codes" });
  await expect(statuses.locator("tbody tr")).toHaveCount(3);
  await expect(statuses.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["404", "210", "2.6%", "4", "Nov 5, 2026, 10:44 AM UTC"]);
  const validation = page.getByRole("table", { name: "Validation errors" });
  await expect(validation.locator("tbody tr").first().getByRole("cell")).toHaveText([
    "query.limit",
    "Input should be less than or equal to 100 (less_than_equal)",
    "80",
    "2",
    "Nov 5, 2026, 10:40 AM UTC",
  ]);

  const exceptions = page.getByRole("list", { name: "Server exceptions" });
  const first = exceptions.getByRole("listitem").first();
  await expect(first.locator("summary")).toContainText("KeyError 'currency'");
  await expect(first.locator("summary")).toContainText("2 times, 1 consumers");
  await expect(first.locator("pre.ep-stack")).toBeHidden();
  await first.locator("summary").click();
  await expect(first.locator("pre.ep-stack")).toContainText('total = order["currency"]');

  // The errors read takes no status filter, so the bar offers none here.
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveCount(0);
  expect((await reads()).map((r) => r.tab)).toEqual(["requests", "errors"]);

  const a11y = await new AxeBuilder({ page }).include(".ep").analyze();
  expect(a11y.violations).toEqual([]);
});

test("Response times tab: percentiles, Apdex, the p50/p75/p95 trend and the histogram, filtered by status", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?tab=latency&range=7d`);
  await expect(tabs(page).getByRole("link", { name: "Response times" })).toHaveAttribute("aria-current", "page");
  await expect(tiles(page).locator("dt")).toHaveText(["p50", "p95", "p99", "Apdex"]);
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["31 ms", "220 ms", "980 ms", "0.97"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["average 48 ms", "p75 64 ms, p90 140 ms", "slowest 2.31 s", "Excellent, target app default"]);

  await expect(page.getByRole("list", { name: "Response time percentiles legend" }).getByRole("listitem")).toHaveText(["p50", "p75", "p95"]);
  const trend = page.getByRole("img", { name: /Response time percentiles/ });
  await expect(trend.locator("path.ep-line")).toHaveCount(3);
  await expect(trend.locator('path[data-series="p95_ms"]')).toHaveAttribute("d", /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){2}$/);
  const hist = page.getByRole("img", { name: /Response time histogram/ });
  await expect(hist.locator(".tr-hit")).toHaveCount(14);
  const bar = await tipAt(page, /^Response time histogram\. Use the arrow keys/, 5);
  await expect(bar.locator(".ct-tip__title")).toHaveText("20–50 ms");
  await expect(bar.locator("dd").first()).toHaveText("2,600");
  await page.keyboard.press("End");
  await expect(bar.locator(".ct-tip__title")).toHaveText("≥10 s");
  await expect(bar.locator("dd").first()).toHaveText("0");
  expect((await reads()).map((r) => [r.tab, r.query])).toEqual([["latency", { range: "7d" }]]);

  // The status filter is in the URL and sent to the read.
  await page.getByRole("combobox", { name: "Status" }).selectOption("5xx");
  await page.waitForURL(/status=5xx/);
  await expect(page.getByRole("img", { name: /Response time percentiles/ })).toHaveAttribute("aria-label", /in the last 7 days, 5xx responses/);
  expect((await reads()).at(-1)?.query).toEqual({ range: "7d", status: "5xx" });
  // Tabs keep the scope.
  await expect(tabs(page).getByRole("link", { name: "Data transferred" })).toHaveAttribute("href", `${PAGE}?tab=transfer&range=7d&status=5xx`);
});

test("Data transferred tab: bytes in and out, the in/out series and both size histograms", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?tab=transfer`);
  await expect(tabs(page).getByRole("link", { name: "Data transferred" })).toHaveAttribute("aria-current", "page");
  await expect(tiles(page).locator("dt")).toHaveText(["Requests", "Received", "Sent", "Total"]);
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["8,200", "1.5 MB", "22 MB", "24 MB"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["in the last 24 hours", "192 B per request", "2.7 KB per response", "request and response bodies"]);

  await expect(page.getByRole("list", { name: "Bytes in and out legend" }).getByRole("listitem")).toHaveText(["Received (requests)", "Sent (responses)"]);
  const series = page.getByRole("img", { name: /Bytes in and out/ });
  await expect(series.locator(".tr-hit")).toHaveCount(4);
  await expect(series.locator(".ep-c-in")).toHaveCount(4);
  await expect(series.locator(".ep-c-out")).toHaveCount(4);
  const bytes = await tipAt(page, /^Bytes in and out\. Use the arrow keys/, 0);
  await expect(bytes.locator("dt")).toHaveText(["Received (requests)", "Sent (responses)", "Total"]);
  await expect(bytes.locator("dd").first()).toHaveText("391 KB");
  await expect(bytes.locator("dd").nth(1)).toHaveText("5.3 MB");

  const req = page.getByRole("img", { name: /Request size histogram/ });
  const res = page.getByRole("img", { name: /Response size histogram/ });
  await expect(req.locator(".tr-hit")).toHaveCount(10);
  await expect(res.locator(".tr-hit")).toHaveCount(10);
  const reqBar = await tipAt(page, /^Request size histogram\. Use the arrow keys/, 0);
  await expect(reqBar.locator(".ct-tip__title")).toHaveText("0 B");
  await expect(reqBar.locator("dd").first()).toHaveText("6,000");
  const resBar = await tipAt(page, /^Response size histogram\. Use the arrow keys/, 3);
  await expect(resBar.locator(".ct-tip__title")).toHaveText("1–4 KB");
  await expect(resBar.locator("dd").first()).toHaveText("5,800");
  expect((await reads()).map((r) => r.tab)).toEqual(["transfer"]);

  const a11y = await new AxeBuilder({ page }).include(".ep").analyze();
  expect(a11y.violations).toEqual([]);
});

test("the settings menu saves expected status codes, the threshold and exclusion", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?tab=errors`);
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Endpoint settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("GET /orders/{id} in app Shop");

  const codes = dialog.getByRole("textbox", { name: "Expected status codes" });
  const threshold = dialog.getByRole("textbox", { name: "Response time threshold (ms)" });
  await codes.fill("404, 4o9");
  await threshold.fill("0");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByText("“4o9” is not a status code.")).toBeVisible();
  await expect(codes).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("Enter whole milliseconds from 1 to 600,000")).toBeVisible();

  await codes.fill("409 404");
  await threshold.fill("250");
  await dialog.getByRole("checkbox", { name: "Exclude from dashboards" }).check();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await expect(page.locator(".ep-badge")).toHaveText("Excluded from dashboards");
  // The Errors tab names the expected codes it leaves out.
  await expect(tiles(page).locator(".tr-tile__value").last()).toHaveText("404, 409");

  // Reopened, the dialog shows what was saved.
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  await expect(codes).toHaveValue("404, 409");
  await expect(threshold).toHaveValue("250");
  await expect(dialog.getByRole("checkbox", { name: "Exclude from dashboards" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the settings are read-only without capture.manage", async ({ page }) => {
  await seed();
  await signIn(page, PAGE, { capabilities: ["project.read"] });
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Endpoint settings" });
  await expect(dialog.getByText("Only project admins can change them.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Expected status codes" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("says so when the endpoint had no requests, and when a tab cannot load", async ({ page }) => {
  await seed({});
  await signIn(page, `${PAGE}?range=1h`);
  await expect(page.getByRole("status").filter({ hasText: "No requests to GET /orders/{id} in the last 1 hour." })).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);

  await seed();
  await queryDown(true);
  await page.goto(`${PAGE}?tab=latency`);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load response times just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(tiles(page).locator(".tr-tile__value").first()).toHaveText("31 ms");
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page, `${PAGE}?tab=errors`);
  await expect(page.getByRole("table", { name: "Error status codes" }).locator("tbody tr")).toHaveCount(3);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("screenshots", async ({ page }) => {
  const dir = process.env.ENDPOINT_SHOTS;
  test.skip(!dir, "set ENDPOINT_SHOTS to a directory to capture screenshots");
  await seed();
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const tab of ["requests", "errors", "latency", "transfer"]) {
      await page.goto(`${PAGE}?tab=${tab}`);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.screenshot({ path: `${dir}/endpoint-${tab}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
