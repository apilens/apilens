// The observability surfaces against the real stack (#625), on data the FastAPI example app
// (examples/fastapi) sends through the Python SDK: Explore and its filters, the request drawer,
// the endpoint detail tabs, marking a status code as expected on the Errors page, and an alert
// rule that opens an incident once the evaluator sees its breach.
//
// Signs in as the owner `apilens seed` creates (dev@example.com, a reserved address) with the
// one-time magic link seed prints, so no email is sent. Every request this run sends carries a
// unique `?e2e=` token, so reruns against the same stack never read another run's rows.
//
//   APILENS_E2E_UI_URL          the dashboard (default http://localhost:3200)
//   APILENS_E2E_MAGIC_LINK      `magic_link` from `apilens seed -app-slug example-fastapi` (required)
//   APILENS_E2E_PROJECT         the seeded project slug (default dev)
//   APILENS_E2E_EXAMPLE_URL     the FastAPI example app, sending to the stack (default http://127.0.0.1:18001)
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const MAGIC_LINK = process.env.APILENS_E2E_MAGIC_LINK ?? "";
const PROJECT = process.env.APILENS_E2E_PROJECT ?? "dev";
const EXAMPLE = (process.env.APILENS_E2E_EXAMPLE_URL ?? "http://127.0.0.1:18001").replace(/\/$/, "");

// A unique token in every URL this run sends, so its rows can be told apart from earlier runs'.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const ORDER_IDS = [101, 102, 103];
const INVALID_ORDERS = 2;
const BOOMS = 3;
const SEEDED = ORDER_IDS.length + INVALID_ORDERS + 1 + BOOMS;

// The session the magic link opens, shared by the tests below (the link works once). Written in
// beforeAll and back after every test, so a refreshed (rotated) token carries over to the next one.
const STATE = join(tmpdir(), `apilens-e2e-surfaces-${RUN}.json`);

test.describe.configure({ mode: "serial" });
test.skip(!MAGIC_LINK, "set APILENS_E2E_MAGIC_LINK to the magic_link `apilens seed` prints");
test.use({ storageState: STATE });

/** Sends one request to the example app and checks its status. */
async function send(method: string, path: string, want: number, body?: unknown) {
  const res = await fetch(`${EXAMPLE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status, `${method} ${path}`).toBe(want);
}

const boom = () => send("GET", `/boom?e2e=${RUN}`, 500);

const at = (page: Page, path: string) => page.waitForURL((url) => url.pathname === path);
const grid = (page: Page) => page.getByRole("grid", { name: "Requests" });
const bodyRows = (page: Page) => grid(page).locator(".ex-spacer [role=row]");
const chips = (page: Page) => page.getByRole("list", { name: "Active filters" });
const endpointPage = (method: string, path: string) => `/${PROJECT}/endpoints/${method}/${encodeURIComponent(path)}`;

/** Clears the expected status codes of an endpoint, so marking one starts from scratch. */
async function clearExpected(page: Page, method: string, path: string) {
  await page.goto(`${endpointPage(method, path)}?tab=errors`);
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Endpoint settings" });
  const codes = dialog.getByRole("textbox", { name: "Expected status codes" });
  await expect(codes).toBeEditable();
  if ((await codes.inputValue()) === "") {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    return;
  }
  await codes.fill("");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  // Sign in once with the magic link (relative to the UI under test, whatever host seed put in it).
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const link = new URL(MAGIC_LINK);
  link.searchParams.set("next", `/${PROJECT}/explore`);
  await page.goto(`${link.pathname}${link.search}`);
  await at(page, `/${PROJECT}/explore`);
  await context.storageState({ path: STATE });
  await context.close();

  // Seed through the SDK: 200s on a templated path, 422s with validation errors, a 201 and 500s.
  for (const id of ORDER_IDS) await send("GET", `/orders/${id}?e2e=${RUN}`, 200);
  for (let i = 0; i < INVALID_ORDERS; i++) await send("POST", `/orders?e2e=${RUN}`, 422, { item: "", quantity: 0, note: `e2e-${RUN}` });
  await send("POST", `/orders?e2e=${RUN}`, 201, { item: "widget", quantity: 2, email: "ada@example.com" });
  for (let i = 0; i < BOOMS; i++) await boom();
});

test.afterEach(async ({ context }) => {
  await context.storageState({ path: STATE });
});

test.afterAll(() => {
  rmSync(STATE, { force: true });
});

test("Explore: the run's requests arrive, and the filters narrow them, kept in the URL", async ({ page }) => {
  // The batch the SDK sent shows up while the log polls (every 5 s while live).
  await page.goto(`/${PROJECT}/explore?url_contains=${RUN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
  await expect(chips(page).getByRole("listitem").filter({ hasNot: page.getByRole("button", { name: "Clear all" }) })).toHaveText([`URL contains “${RUN}”`]);
  await expect(bodyRows(page)).toHaveCount(SEEDED, { timeout: 30_000 });
  await expect(grid(page).getByRole("columnheader")).toHaveText(["Time", "Method", "Path", "Status", "Latency", "Consumer", "Size"]);

  // Status, typed into the bar: applies once typing pauses.
  await page.getByRole("button", { name: "Filters (1)" }).click();
  await page.getByLabel("Status", { exact: true }).fill("4xx, 5xx");
  await page.waitForURL((u) => u.searchParams.get("status") === "4xx,5xx");
  await expect(bodyRows(page)).toHaveCount(INVALID_ORDERS + BOOMS);

  // Method, picked: applies at once; the rows are the invalid orders.
  await page.getByLabel("Method", { exact: true }).selectOption("POST");
  await page.waitForURL((u) => u.searchParams.get("method") === "POST");
  await expect(bodyRows(page)).toHaveCount(INVALID_ORDERS);
  for (let i = 0; i < INVALID_ORDERS; i++) {
    await expect(bodyRows(page).nth(i).getByRole("gridcell")).toContainText(["POST", `/orders?e2e=${RUN}`, "422"]);
  }

  // Path is the route template: the three order reads, whatever their ids.
  await chips(page).getByRole("button", { name: "Remove filter: Method POST" }).click();
  await page.waitForURL((u) => !u.searchParams.has("method") && u.searchParams.has("status"));
  await expect(bodyRows(page)).toHaveCount(INVALID_ORDERS + BOOMS);
  await chips(page).getByRole("button", { name: "Remove filter: Status 4xx, 5xx" }).click();
  await page.waitForURL((u) => !u.searchParams.has("status") && u.searchParams.has("url_contains"));
  await page.getByLabel("Path", { exact: true }).fill("/orders/{order_id}");
  await page.waitForURL((u) => u.searchParams.get("path") === "/orders/{order_id}");
  await expect(bodyRows(page)).toHaveCount(ORDER_IDS.length);
  await expect(page.getByText(`The newest ${ORDER_IDS.length} requests in the last 1 hour matching the filters, newest first.`)).toBeVisible();

  // A shared link reproduces the view; Clear all drops every filter.
  await page.reload();
  await expect(chips(page).getByRole("listitem").filter({ hasNot: page.getByRole("button", { name: "Clear all" }) })).toHaveText([
    "Path /orders/{order_id}",
    `URL contains “${RUN}”`,
  ]);
  await expect(bodyRows(page)).toHaveCount(ORDER_IDS.length);
  await chips(page).getByRole("button", { name: "Clear all" }).click();
  await page.waitForURL((u) => u.search === "");
  await expect(chips(page)).toHaveCount(0);
});

test("Request detail: the drawer shows what the SDK captured, with validation errors", async ({ page }) => {
  await page.goto(`/${PROJECT}/explore?method=POST&status=422&url_contains=${RUN}`);
  await expect(bodyRows(page)).toHaveCount(INVALID_ORDERS, { timeout: 30_000 });
  await bodyRows(page).first().click();

  const drawer = page.getByRole("dialog");
  const panel = drawer.getByRole("tabpanel");
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(`POST /orders?e2e=${RUN}`);
  await expect(drawer.getByRole("tab")).toHaveText(["Overview", "Headers", "Request body", "Response body", "Validation2", /^Trace/, /^Logs/]);
  await expect(panel).toContainText("422");

  await drawer.getByRole("tab", { name: "Headers" }).click();
  await expect(panel.getByRole("region", { name: "Request headers" })).toContainText(/content-type/i);

  await drawer.getByRole("tab", { name: "Request body" }).click();
  await expect(panel).toContainText(`e2e-${RUN}`);

  // FastAPI's validation answer, collapsed below its top level.
  await drawer.getByRole("tab", { name: "Response body" }).click();
  await expect(panel).toContainText('"detail": […] 2 items');

  await drawer.getByRole("tab", { name: /^Validation/ }).click();
  const fields = panel.getByRole("row");
  await expect(fields.filter({ hasText: "body.item" })).toHaveCount(1);
  await expect(fields.filter({ hasText: "body.quantity" })).toContainText("greater_than");

  await drawer.getByRole("button", { name: "Close request details" }).click();
  await expect(drawer).toHaveCount(0);
});

test("Endpoint detail: every tab reads the endpoint's own data", async ({ page }) => {
  const PAGE = endpointPage("POST", "/orders");
  await page.goto(PAGE);
  const tabs = page.getByRole("navigation", { name: "Endpoint views" });
  const tiles = page.locator("dl.ep-tiles");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("POST /orders");
  await expect(page.locator("dl.ep-locked dd")).toHaveText(["POST", "/orders", "Example Fastapi"]);
  await expect(tabs.getByRole("link")).toHaveText(["Requests", "Errors", "Response times", "Data transferred"]);

  // Requests.
  await expect(tabs.getByRole("link", { name: "Requests" })).toHaveAttribute("aria-current", "page");
  await expect(tiles.locator("dt")).toHaveText(["Requests", "Successful", "Client errors (4xx)", "Server errors (5xx)"]);
  await expect(page.getByRole("img", { name: /Requests by status/ })).toBeVisible();

  // Errors: the 422s with their validation errors.
  await tabs.getByRole("link", { name: "Errors" }).click();
  await page.waitForURL(/tab=errors/);
  await expect(tabs.getByRole("link", { name: "Errors" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("img", { name: /Error rate/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Error status codes" }).locator("tbody tr").first().getByRole("cell").first()).toHaveText("422");
  const validation = page.getByRole("table", { name: "Validation errors" });
  await expect(validation.locator("tbody tr").filter({ hasText: "body.quantity" })).toContainText("greater_than");

  // Response times.
  await tabs.getByRole("link", { name: "Response times" }).click();
  await page.waitForURL(/tab=latency/);
  await expect(tabs.getByRole("link", { name: "Response times" })).toHaveAttribute("aria-current", "page");
  await expect(tiles.locator("dt")).toHaveText(["p50", "p95", "p99", "Apdex"]);
  await expect(page.getByRole("img", { name: /Response time percentiles/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Response time histogram/ })).toBeVisible();

  // Data transferred.
  await tabs.getByRole("link", { name: "Data transferred" }).click();
  await page.waitForURL(/tab=transfer/);
  await expect(tabs.getByRole("link", { name: "Data transferred" })).toHaveAttribute("aria-current", "page");
  await expect(tiles.locator("dt")).toHaveText(["Requests", "Received", "Sent", "Total"]);
  await expect(page.getByRole("img", { name: /Bytes in and out/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Request size histogram/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Response size histogram/ })).toBeVisible();

  // The unhandled exception behind /boom, with its stack trace.
  await page.goto(`${endpointPage("GET", "/boom")}?tab=errors`);
  const exception = page.getByRole("list", { name: "Server exceptions" }).getByRole("listitem").first();
  await expect(exception.locator("summary")).toContainText("RuntimeError");
  await exception.locator("summary").click();
  await expect(exception.locator("pre.ep-stack")).toContainText("example failure: /boom always raises");
});

test("Errors: marking 422 as expected for POST /orders stops counting it, and clearing it restores it", async ({ page }) => {
  // Start from no expected codes, whatever an earlier run left.
  await clearExpected(page, "POST", "/orders");

  await page.goto(`/${PROJECT}/errors?code=422&view=details`);
  const dialog = page.getByRole("dialog", { name: "422 Unprocessable Content" });
  const orders = dialog.getByRole("listitem").filter({ hasText: "/orders" });
  await expect(orders).toContainText("with validation errors");
  await orders.getByRole("button", { name: "Mark 422 as expected" }).click();
  const confirm = orders.getByRole("group", { name: "Mark 422 as expected for POST /orders?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Mark as expected", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "422 is now expected for POST /orders." })).toBeVisible();
  // No other endpoint of the example answers 422, so nothing counts it as an error any more.
  await expect(dialog.getByRole("listitem").filter({ hasText: "/orders" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.waitForURL((url) => !url.search.includes("code="));
  const statuses = page.getByRole("table", { name: "Error status codes" });
  await expect(statuses.getByRole("row").filter({ hasText: "500 Internal Server Error" })).toHaveCount(1);
  await expect(statuses.getByRole("row").filter({ hasText: "422 Unprocessable Content" })).toHaveCount(0);

  // The endpoint's own settings list it; clearing them counts 422 as an error again.
  await page.goto(`${endpointPage("POST", "/orders")}?tab=errors`);
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  await expect(page.getByRole("dialog", { name: "Endpoint settings" }).getByRole("textbox", { name: "Expected status codes" })).toHaveValue("422");
  await page.keyboard.press("Escape");
  await clearExpected(page, "POST", "/orders");
  await page.goto(`/${PROJECT}/errors`);
  await expect(page.getByRole("table", { name: "Error status codes" }).getByRole("row").filter({ hasText: "422 Unprocessable Content" })).toHaveCount(1);
});

test("Alerts: a rule on GET /boom opens an incident once the evaluator sees the breach", async ({ page }) => {
  // The evaluator runs every minute; the first run after the rule exists opens the incident.
  test.setTimeout(240_000);
  const name = `E2E boom ${RUN}`;

  await page.goto(`/${PROJECT}/incidents/rules/new`);
  const form = page.getByRole("form", { name: "New alert rule" });
  await form.getByLabel("Name").fill(name);
  await expect(form.getByLabel("App")).toHaveValue(/.+/);
  await form.getByLabel("App").selectOption({ label: "Example Fastapi" });
  await expect(form.getByLabel("Environment")).toHaveValue("production");
  await form.getByLabel("Endpoint").fill("GET /boom");
  await expect(form.getByLabel("Metric")).toHaveValue(/.+/);
  await form.getByLabel("Metric").selectOption({ label: "Error rate" });
  await form.getByLabel("Threshold").fill("50");
  await form.getByLabel("Notify after").fill("0");
  await form.getByRole("button", { name: "Create rule" }).click();
  await at(page, `/${PROJECT}/incidents/rules`);
  const rule = page.getByRole("table", { name: "Alert rules" }).locator("tbody tr").filter({ hasText: name });
  await expect(rule).toContainText("Error rate > 50% over 5 min");
  await expect(rule).toContainText("GET /boom");

  // Every /boom in the window failed: 100% > 50%. Send a few more so the window surely holds some.
  for (let i = 0; i < BOOMS; i++) await boom();

  await page.goto(`/${PROJECT}/incidents`);
  const incident = page.getByRole("table", { name: "Open incidents" }).locator("tbody tr").filter({ hasText: name });
  await expect(async () => {
    await page.reload();
    await expect(incident).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 180_000, intervals: [5_000] });
  await expect(incident).toContainText("Triggered");
  await expect(incident).toContainText("100%");
  await expect(incident).toContainText("threshold > 50%");

  // Its timeline opens from the incident.
  await incident.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByRole("list", { name: "Incidents of this rule" })).toContainText("Triggered");

  // Leave the stack as it was: delete the rule.
  await page.goto(`/${PROJECT}/incidents/rules`);
  await page.getByRole("table", { name: "Alert rules" }).getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete rule" }).click();
  await at(page, `/${PROJECT}/incidents/rules`);
  await expect(page.getByRole("table", { name: "Alert rules" }).getByRole("link", { name })).toHaveCount(0);
});
