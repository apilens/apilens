// Explore request drawer (#588) against the fake identity (e2e-fake/fake-identity.ts), which plays
// the query role: `GET /requests` answers the rows `/__fake/requests` seeded for shop, and
// `GET /requests/{id}` the row with that id merged with its `detail`. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/explore";

type Row = Record<string, unknown>;

const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const T0 = at(300);
const plus = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** A response body of a bit over 64 KB of JSON, the size the SDK captures at most by default. */
const BIG = JSON.stringify({ items: Array.from({ length: 1500 }, (_, i) => ({ id: i, sku: `SKU-${i}`, tags: ["a", "b"] })) });

const ROWS: Row[] = [
  {
    id: "req-one",
    timestamp: T0,
    app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    method: "POST",
    path: "/orders",
    raw_path: "/orders?token=[redacted]",
    status_code: 422,
    response_time_ms: 84,
    request_size: 120,
    response_size: BIG.length,
    environment: "production",
    ip_address: "203.0.113.7",
    consumer_id: "c_acme",
    consumer_name: "Acme Corp",
    consumer_group: "Partners",
    sampled: true,
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    detail: {
      request: {
        span_id: "00f067aa0ba902b7",
        user_agent: "curl/8.7.1",
        base_url: "https://api.example.com",
        release: "2026.11.5",
        commit: "a1b2c3d",
        request_headers: JSON.stringify({ "Content-Type": "application/json", Authorization: "[redacted]", "Content-Length": "48" }),
        response_headers: JSON.stringify({ "Content-Type": "application/json" }),
        request_body: JSON.stringify({ email: "ada@example.com", password: "[redacted]", items: [{ sku: "SKU-1", qty: 0 }] }),
        response_body: BIG,
        attributes: { region: "eu-west-1" },
        validation_errors: [{ loc: "body.items[0].qty", msg: "must be greater than 0", type: "greater_than" }],
      },
      spans: [
        { span_id: "00f067aa0ba902b7", parent_span_id: "", name: "POST /orders", kind: "server", service_name: "shop", start: T0, duration_ms: 84, status: "error", status_code: 422, attributes: {} },
        { span_id: "s-db", parent_span_id: "00f067aa0ba902b7", name: "SELECT orders", kind: "client", service_name: "postgres", start: plus(10), duration_ms: 30, status: "ok", status_code: 0, attributes: {} },
        { span_id: "s-cache", parent_span_id: "00f067aa0ba902b7", name: "GET cart", kind: "client", service_name: "redis", start: plus(2), duration_ms: 4, status: "ok", status_code: 0, attributes: {} },
      ],
      logs: [
        { timestamp: plus(12), level: "INFO", message: "validating order", span_id: "00f067aa0ba902b7" },
        { timestamp: plus(60), level: "ERROR", message: "rejected: token=[redacted]", span_id: "s-db" },
      ],
    },
  },
  {
    id: "req-two",
    timestamp: at(900),
    app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    method: "GET",
    path: "/health",
    raw_path: "/health",
    status_code: 200,
    response_time_ms: 3,
    request_size: 0,
    response_size: 0,
    environment: "production",
    ip_address: "",
    consumer_id: "",
    consumer_name: "",
    consumer_group: "",
    sampled: false,
    trace_id: "",
  },
  {
    id: "req-gone",
    timestamp: at(1200),
    app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    method: "GET",
    path: "/gone",
    raw_path: "/gone",
    status_code: 200,
    response_time_ms: 3,
    environment: "production",
    consumer_id: "",
    consumer_name: "",
    trace_id: "",
  },
];

async function seed(rows: Row[] | null) {
  const res = await fetch(`${IDENTITY}/__fake/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", rows }),
  });
  expect(res.status).toBe(204);
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

const grid = (page: Page) => page.getByRole("grid", { name: "Requests" });
const rowAt = (page: Page, i: number) => grid(page).locator(`[data-index="${i}"]`);
const drawer = (page: Page) => page.getByRole("dialog");
const tab = (page: Page, name: string) => drawer(page).getByRole("tab", { name });
const panel = (page: Page) => drawer(page).getByRole("tabpanel");

test.afterEach(async () => {
  await seed(null);
});

test("opens a row in the drawer and shows every tab", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seed(ROWS);
  await signIn(page);
  await rowAt(page, 0).click();

  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole("heading", { level: 2 })).toHaveText("POST /orders?token=[redacted]");
  await expect(drawer(page).getByRole("tab")).toHaveText(["Overview", "Headers", "Request body", "Response body", "Validation1", "Trace3", "Logs2"]);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");

  // Overview: the record and the drawer-only columns.
  await expect(panel(page).getByText("curl/8.7.1")).toBeVisible();
  await expect(panel(page).getByText("Partners")).toBeVisible();
  await expect(panel(page).getByText("eu-west-1")).toBeVisible();
  await expect(panel(page).getByText("https://api.example.com/orders?token=[redacted]")).toBeVisible();

  // Headers: redacted values are marked, not shown as data.
  await tab(page, "Headers").click();
  await expect(panel(page).getByRole("region", { name: "Request headers" }).getByRole("row")).toHaveCount(3);
  const redacted = panel(page).locator(".rd-marker--redacted").first();
  await expect(redacted).toHaveText("[redacted]");
  await expect(redacted).toHaveAttribute("title", "Redacted by the SDK before it left your app");
  const plain = await panel(page).locator("td").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await redacted.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(plain);

  // Request body: a JSON tree with the password marked.
  await tab(page, "Request body").click();
  await expect(panel(page).locator(".rd-j-line")).toContainText(['"email": "ada@example.com"']);
  await expect(panel(page).locator(".rd-marker--redacted")).toHaveText('[redacted]');

  // Validation: the field errors as a table.
  await tab(page, "Validation").click();
  await expect(panel(page).getByRole("row").nth(1).getByRole("cell")).toHaveText(["body.items[0].qty", "must be greater than 0", "greater_than"]);

  // Trace: the spans as a waterfall, parent first, children by start; the failed span says so.
  await tab(page, "Trace").click();
  await expect(panel(page).locator(".rd-wf__row .rd-wf__name > span:first-child")).toHaveText(["POST /orders", "GET cart", "SELECT orders"]);
  await expect(panel(page).locator(".rd-wf__row.is-error")).toHaveCount(1);
  await expect(panel(page).getByText("3 spans over 84 ms")).toBeVisible();

  // Logs: oldest first, timed from the request, with their span.
  await tab(page, "Logs").click();
  await expect(panel(page).getByRole("row").nth(1).getByRole("cell")).toHaveText(["+12.0 ms", "INFO", "validating orderin POST /orders"]);
  await expect(panel(page).getByRole("row").nth(2).locator(".rd-marker--redacted")).toBeVisible();

  // Copy as cURL: the stored request, redacted values left as markers.
  await drawer(page).getByRole("button", { name: "Copy as cURL" }).click();
  await expect(drawer(page).getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  const curl = await page.evaluate(() => navigator.clipboard.readText());
  expect(curl).toContain("curl -X POST 'https://api.example.com/orders?token=[redacted]'");
  expect(curl).toContain("-H 'Authorization: [redacted]'");
  expect(curl).not.toContain("Content-Length");
  expect(curl).toContain(`--data-raw '{"email":"ada@example.com","password":"[redacted]"`);

  const a11y = await new AxeBuilder({ page }).include(".rd").analyze();
  expect(a11y.violations).toEqual([]);

  // Escape closes it and focus goes back to the row.
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(rowAt(page, 0)).toBeFocused();
});

test("renders a 64 KB body collapsed and virtualised, without jank", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await rowAt(page, 0).click();
  await tab(page, "Response body").click();
  const lines = panel(page).locator(".rd-j-line");
  // Opened only as far as is cheap: the 1500 items start as one line.
  await expect(lines).toHaveText(["▾{", '▸"items": […] 1500 items', "}"]);

  // Expand all: some 12 000 lines, but only the ones in view are in the DOM.
  const started = Date.now();
  await panel(page).getByRole("button", { name: "Expand all" }).click();
  await expect(lines.first()).toHaveText("▾{");
  await expect(panel(page).locator(".rd-json__spacer")).toHaveAttribute("style", /height: \d{5,}px/);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await lines.count()).toBeLessThan(120);

  const frames = await panel(page)
    .locator(".rd-json__scroll")
    .evaluate(async (el) => {
      const times: number[] = [];
      const max = el.scrollHeight - el.clientHeight;
      let last = performance.now();
      for (let i = 1; i <= 60; i++) {
        el.scrollTop = (max * i) / 60;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const t = performance.now();
        times.push(t - last);
        last = t;
      }
      return times.sort((a, b) => a - b);
    });
  const median = frames[Math.floor(frames.length / 2)];
  console.log(`64 KB body scroll: median frame ${median.toFixed(1)} ms over ${frames.length} frames`);
  expect(median).toBeLessThan(20);
  await expect(lines.last()).toHaveText("}");
  expect(await lines.count()).toBeLessThan(120);

  // A container toggles from its line.
  await panel(page).getByRole("button", { name: "Collapse all" }).click();
  await expect(lines).toHaveText(["▾{", '▸"items": […] 1500 items', "}"]);
  await panel(page).getByRole("button", { name: "Expand items" }).click();
  await expect(panel(page).getByRole("button", { name: "Collapse items" })).toHaveAttribute("aria-expanded", "true");
});

test("opens with Enter, moves between tabs with arrows, and says so for a sampled-out request", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await rowAt(page, 0).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(drawer(page).getByRole("heading", { level: 2 })).toHaveText("GET /health");
  await expect(drawer(page).getByRole("tab")).toHaveText(["Overview", "Headers", "Request body", "Response body", "Validation", "Trace", "Logs"]);
  await expect(panel(page).getByText("Sampled out: the SDK kept a base record")).toBeVisible();

  await tab(page, "Overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Headers")).toBeFocused();
  await expect(tab(page, "Headers")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByText("Sampled out: the SDK kept a base record")).toBeVisible();
  await page.keyboard.press("End");
  await expect(tab(page, "Logs")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByText("This request has no trace id, so no logs are linked to it.")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(panel(page).getByText("This request has no trace id, so there is no trace to show.")).toBeVisible();

  await drawer(page).getByRole("button", { name: "Close request details" }).click();
  await expect(drawer(page)).toHaveCount(0);
});

test("says so when the request is no longer stored", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  // The log still lists it; the detail read no longer finds it.
  await page.route("**/api/projects/shop/requests/req-gone", (route) => route.fulfill({ status: 404, json: { ok: false, code: "not_found" } }));
  await rowAt(page, 2).click();
  await expect(panel(page).getByText("This request is no longer stored.")).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
});

test("fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(ROWS);
  await signIn(page);
  await rowAt(page, 0).click();
  await tab(page, "Trace").click();
  await expect(panel(page).locator(".rd-wf__row")).toHaveCount(3);
  const overflow = await drawer(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
