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
  await expect(panel(page).locator(".rd-wf__label")).toHaveText(["POST /orders", "GET cart", "SELECT orders"]);
  await expect(panel(page).locator(".rd-wf__item.is-error")).toHaveCount(1);
  await expect(panel(page).getByText("3 spans over 84 ms")).toBeVisible();
  // A span opens in place to its detail, and closes again.
  const span = panel(page).getByRole("button", { name: /GET cart/ });
  await span.click();
  await expect(span).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page).getByRole("region", { name: "Span GET cart" })).toBeVisible();
  await span.click();
  await expect(panel(page).getByRole("region", { name: "Span GET cart" })).toHaveCount(0);

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

// ---------------------------------------------------------------- exceptions (#924)

const PY_PAYLOAD = `Traceback (most recent call last):
  File "/app/shop/payments.py", line 6, in pay
    charge()
  File "/usr/lib/python3.12/site-packages/stripe/api.py", line 3, in charge
    raise ConnectionError("card gateway timed out")
ConnectionError: card gateway timed out

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/app/shop/views.py", line 15, in create_order
    pay()
  File "/app/shop/payments.py", line 8, in pay
    raise RuntimeError("payment failed") from e
RuntimeError: payment failed
`;

const NODE_PAYLOAD = `Error: load cart failed
    at load (/app/src/cart.js:2:54)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
…[2048 chars truncated]…
Caused by: RangeError: pool exhausted
    at query (/app/src/db.js:1:26)`;

const JAVA_PAYLOAD = `java.lang.IllegalStateException: order 42 rejected
\tat com.shop.orders.OrderService.create(OrderService.java:42)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)
Caused by: java.net.SocketTimeoutException: Read timed out
\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(Native Method)
\t... 5 more
`;

function failing(id: string, ago: number, payload: string, type: string, message: string): Row {
  const t = at(ago);
  const later = (ms: number) => new Date(Date.parse(t) + ms).toISOString();
  return {
    id,
    timestamp: t,
    app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    method: "POST",
    path: `/${id}`,
    raw_path: `/${id}`,
    status_code: 500,
    response_time_ms: 40,
    environment: "production",
    consumer_id: "",
    consumer_name: "",
    sampled: true,
    trace_id: `${id}-trace`,
    detail: {
      spans: [
        {
          span_id: `${id}-root`,
          parent_span_id: "",
          name: `POST /${id}`,
          kind: "server",
          service_name: "shop",
          start: t,
          duration_ms: 40,
          status: "error",
          status_code: 500,
          status_message: `${type}: ${message}`,
          attributes: { "http.route": `/${id}`, "http.response.status_code": "500" },
          events: [
            { time: later(5), name: "cache.miss", attributes: { key: "cart:42" } },
            { time: later(39), name: "exception", attributes: { "exception.type": type, "exception.message": message, "exception.stacktrace": payload, "exception.escaped": "true" } },
          ],
          links: [],
        },
      ],
      logs: [
        {
          timestamp: later(39),
          level: "ERROR",
          message: `${type}: ${message}`,
          logger_name: "apilens.exception",
          span_id: `${id}-root`,
          payload,
          attributes: { "exception.type": type, "exception.message": message, "exception.chain_depth": "1" },
        },
      ],
    },
  };
}

const EXC_ROWS: Row[] = [
  failing("py", 100, PY_PAYLOAD, "RuntimeError", "payment failed"),
  failing("node", 200, NODE_PAYLOAD, "Error", "load cart failed"),
  failing("java", 300, JAVA_PAYLOAD, "java.lang.IllegalStateException", "order 42 rejected"),
];

const exception = (page: Page) => panel(page).getByRole("region", { name: "Exception", exact: true });
const blocks = (page: Page) => exception(page).locator(".rd-exb > summary");

async function openTrace(page: Page, index: number) {
  await rowAt(page, index).click();
  await tab(page, "Trace").click();
}

test("shows the full Python exception with its cause and copies the raw payload", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seed(EXC_ROWS);
  await signIn(page);
  await openTrace(page, 0);

  await expect(exception(page).locator(".rd-exc__title")).toHaveText("RuntimeErrorpayment failed");
  await expect(blocks(page)).toHaveText(["RaisedRuntimeErrorpayment failed", "Caused byConnectionErrorcard gateway timed out"]);
  // The raised exception is open, its cause collapsed until asked for.
  const raised = exception(page).locator(".rd-exb").first();
  await expect(raised.locator(".rd-frame")).toHaveCount(2);
  await expect(raised.locator(".rd-frame.is-app").first()).toContainText("/app/shop/views.py:15 in create_order");
  await expect(raised.locator(".rd-frame__code").first()).toHaveText("pay()");
  const cause = exception(page).locator(".rd-exb").nth(1);
  await expect(cause.locator(".rd-frame").first()).toBeHidden();
  await blocks(page).nth(1).click();
  await expect(cause.locator(".rd-frame")).toHaveCount(2);
  await expect(cause.locator(".rd-frame.is-app")).toHaveCount(1);
  await expect(cause.locator(".rd-frame").nth(1)).not.toHaveClass(/is-app/);

  await exception(page).getByRole("button", { name: "Copy exception" }).click();
  await expect(exception(page).getByRole("status")).toHaveText("Copied the full exception.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PY_PAYLOAD);

  const a11y = await new AxeBuilder({ page }).include(".rd").analyze();
  expect(a11y.violations).toEqual([]);
});

test("shows Node and Java exceptions with causes and the truncation notice", async ({ page }) => {
  await seed(EXC_ROWS);
  await signIn(page);

  await openTrace(page, 1);
  await expect(blocks(page)).toHaveText(["RaisedErrorload cart failed", "Caused byRangeErrorpool exhausted"]);
  await expect(exception(page).getByText("2,048 chars were cut from the middle of this exception")).toBeVisible();
  await expect(exception(page).locator(".rd-exb").first().locator(".rd-frame")).toHaveText([
    "/app/src/cart.js:2 in loadapp",
    "/app/node_modules/express/lib/router/layer.js:95 in Layer.handle",
  ]);
  await drawer(page).getByRole("button", { name: "Close request details" }).click();

  await openTrace(page, 2);
  await expect(blocks(page)).toHaveText(["Raisedjava.lang.IllegalStateExceptionorder 42 rejected", "Caused byjava.net.SocketTimeoutExceptionRead timed out"]);
  await expect(exception(page).locator(".rd-exb").first().locator(".rd-frame.is-app")).toHaveText(["OrderService.java:42 in com.shop.orders.OrderService.createapp"]);
  await blocks(page).nth(1).click();
  await expect(exception(page).locator(".rd-exb").nth(1).locator(".rd-frame")).toHaveText(["Native Method in sun.nio.ch.NioSocketImpl.timedRead", "... 5 more"]);
});

test("a span opens its attributes, status message and events", async ({ page }) => {
  await seed(EXC_ROWS);
  await signIn(page);
  await openTrace(page, 2);

  const span = panel(page).getByRole("region", { name: "Span POST /java" });
  await expect(span).toHaveCount(0);
  const pick = panel(page).locator(".rd-wf__row").first();
  await pick.click();
  await expect(pick).toHaveAttribute("aria-expanded", "true");
  await expect(span.getByText("java.lang.IllegalStateException: order 42 rejected").first()).toBeVisible();
  await expect(span.getByRole("table", { name: "Span attributes" }).getByRole("row")).toHaveText(["http.route/java", "http.response.status_code500"]);
  await expect(span.locator(".rd-event__head code")).toHaveText(["cache.miss", "exception"]);
  await expect(span.getByRole("table", { name: "cache.miss attributes" })).toContainText("cart:42");
  // The exception event renders like the request's exception.
  const event = span.getByRole("region", { name: "Exception event" });
  await expect(event.locator(".rd-exb > summary")).toHaveText(["Raisedjava.lang.IllegalStateExceptionorder 42 rejected", "Caused byjava.net.SocketTimeoutExceptionRead timed out"]);
  await expect(span.getByRole("table", { name: "exception attributes" })).toHaveText("exception.escapedtrue");

  await pick.click();
  await expect(span).toHaveCount(0);
});

test("a log row expands to its payload and attributes, and the exception log links to the Exception section", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seed(EXC_ROWS);
  await signIn(page);
  await rowAt(page, 0).click();
  await tab(page, "Logs").click();

  const toggle = panel(page).getByRole("button", { name: /RuntimeError: payment failed/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel(page).getByLabel("Log payload")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The payload: monospace, scrollable, exactly as stored.
  const payload = panel(page).getByLabel("Log payload");
  await expect(payload).toBeVisible();
  expect(await payload.textContent()).toBe(PY_PAYLOAD);
  const style = await payload.evaluate((el) => ({ font: getComputedStyle(el).fontFamily, overflow: getComputedStyle(el).overflowY }));
  expect(style.overflow).toBe("auto");
  expect(style.font.toLowerCase()).toMatch(/mono/);
  await expect(panel(page).getByRole("table", { name: "Log attributes" }).getByRole("row")).toHaveText([
    "exception.typeRuntimeError",
    "exception.messagepayment failed",
    "exception.chain_depth1",
  ]);

  await panel(page).getByRole("button", { name: "Copy payload" }).click();
  await expect(panel(page).getByRole("status").filter({ hasText: "Copied the payload." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PY_PAYLOAD);

  const a11y = await new AxeBuilder({ page }).include(".rd").analyze();
  expect(a11y.violations).toEqual([]);

  // The exception log links to the Trace tab's Exception section, which takes focus.
  await panel(page).getByRole("button", { name: "View the exception" }).click();
  await expect(tab(page, "Trace")).toHaveAttribute("aria-selected", "true");
  await expect(exception(page)).toBeFocused();

  // A second click on the row collapses it again.
  await tab(page, "Logs").click();
  const again = panel(page).getByRole("button", { name: /RuntimeError: payment failed/ });
  await again.click();
  await expect(panel(page).getByLabel("Log payload")).toBeVisible();
  await again.click();
  await expect(panel(page).getByLabel("Log payload")).toHaveCount(0);
});

test("a log without payload or attributes says so when expanded", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await rowAt(page, 0).click();
  await tab(page, "Logs").click();
  await panel(page).getByRole("button", { name: /validating order/ }).click();
  await expect(panel(page).getByText("No payload was reported for this log.")).toBeVisible();
  await expect(panel(page).getByText("No attributes were reported for this log.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "View the exception" })).toHaveCount(0);
});
