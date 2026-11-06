// Errors dashboard (#594) against the fake identity (e2e-fake/fake-identity.ts), which plays the
// query role: `GET /errors/status`, `/errors/status/{code}` and `/errors` count the rows
// `/__fake/errors` seeded (or answer 503 when seeded down), leaving out a status code an
// endpoint's saved settings mark as expected, so marking one is seen on every read. The endpoints
// here are not the endpoint spec's, so the two files can run in parallel. No email is sent.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/errors";

const BUCKETS = [0, 1, 2, 3].map((i) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString());
const ROWS = [
  { method: "GET", path: "/invoices/{id}", status_code: 404, bucket: 0, count: 100, consumer_id: "c_acme", consumer_name: "Acme Corp" },
  { method: "GET", path: "/invoices/{id}", status_code: 404, bucket: 1, count: 60, consumer_id: "c_globex" },
  { method: "GET", path: "/invoices/{id}", status_code: 404, bucket: 2, count: 50 },
  { method: "POST", path: "/invoices", status_code: 422, bucket: 1, count: 80, consumer_id: "c_acme", consumer_name: "Acme Corp", validation_errors: 80 },
  { method: "GET", path: "/invoices/{id}", status_code: 500, bucket: 3, count: 2, consumer_id: "c_acme", consumer_name: "Acme Corp", exceptions: 2 },
  { method: "GET", path: "/users/{id}", status_code: 404, bucket: 2, count: 40, consumer_id: "c_acme", consumer_name: "Acme Corp" },
];

async function seed(rows: unknown[] = ROWS, requests = [2000, 2200, 1800, 2200], down = false) {
  const res = await fetch(`${IDENTITY}/__fake/errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", buckets: BUCKETS, requests, rows, down }),
  });
  expect(res.status).toBe(204);
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

const tiles = (page: Page) => page.locator(".er > dl.er-tiles");
const statusTable = (page: Page) => page.getByRole("table", { name: "Error status codes" });
const modal = (page: Page, name: string) => page.getByRole("dialog", { name });

/** The hover tooltip of chart `name` at bucket `i` (0-based), reached with the keyboard. */
async function tipAt(page: Page, name: RegExp, i: number) {
  const box = page.getByRole("group", { name });
  await box.focus();
  await page.keyboard.press("Home");
  for (let k = 0; k < i; k++) await page.keyboard.press("ArrowRight");
  return box.locator(".ct-tip");
}

test.afterEach(async () => {
  await seed([], []);
});

test("Status codes tab: tiles, 4xx/5xx over time and the status table", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Errors");
  await expect(page.getByRole("navigation", { name: "Error views" }).getByRole("link")).toHaveText(["Status codes", "Issues"]);
  await expect(page.getByRole("link", { name: "Errors", exact: true })).toHaveAttribute("aria-current", "page");

  await expect(tiles(page).locator("dt")).toHaveText(["Requests", "Error rate", "Client errors (4xx)", "Server errors (5xx)"]);
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["8,200", "4.0%", "330", "2"]);
  await expect(tiles(page).locator(".tr-tile__sub")).toHaveText(["in the last 24 hours", "332 errors", "4% of requests", "<0.1% of requests"]);

  await expect(page.getByRole("list", { name: "Errors by status class legend" }).getByRole("listitem")).toHaveText(["4xx", "5xx"]);
  const chart = page.getByRole("img", { name: /Errors by status class/ });
  await expect(chart).toHaveAttribute("aria-label", /330 4xx and 2 5xx responses in the last 24 hours/);
  await expect(chart.locator("g")).toHaveCount(4);
  // The shared chart hover: the keyboard steps through the buckets and reads each one's exact counts.
  const plot = page.getByRole("group", { name: /^Errors by status class/ });
  await plot.focus();
  await plot.press("Home");
  await plot.press("ArrowRight");
  await expect(plot.locator(".ct-tip")).toContainText("140");
  await expect(page.locator(".tr-chart").first().locator(".ct-sr")).toHaveText(/4xx: 140, 5xx: 0, Total: 140/);

  await expect(statusTable(page).getByRole("columnheader")).toHaveText(["Status", "Responses", "Share of requests", "Endpoints", "Consumers", "Over time", "Last seen"]);
  await expect(statusTable(page).locator("tbody tr")).toHaveCount(3);
  await expect(statusTable(page).locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["404 Not Found", "250", "3.0%", "2", "2", "", "Nov 5, 2026, 10:30 AM UTC"]);
  await expect(statusTable(page).locator("tbody tr").nth(1).getByRole("cell")).toHaveText(["422 Unprocessable Content", "80", "1.0%", "1", "1", "", "Nov 5, 2026, 10:15 AM UTC"]);
  await expect(statusTable(page).locator("tbody tr").nth(2).getByRole("cell").first()).toHaveText("500 Internal Server Error");

  const a11y = await new AxeBuilder({ page }).include(".er").analyze();
  expect(a11y.violations).toEqual([]);

  // The scope is in the URL and every link keeps it.
  await page.getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "7d" }).click();
  await page.waitForURL(/range=7d/);
  await expect(statusTable(page).getByRole("link", { name: "404 Not Found" })).toHaveAttribute("href", `${PAGE}?range=7d&code=404`);
});

test("a status code opens its detail: summary and frequency, consumers and per-endpoint details", async ({ page }) => {
  await seed();
  await signIn(page);
  await statusTable(page).getByRole("link", { name: "404 Not Found" }).click();
  await page.waitForURL(/code=404/);
  const dialog = modal(page, "404 Not Found");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Responses with status 404 counted as errors in the last 24 hours.");

  const views = dialog.getByRole("navigation", { name: "Status 404 views" });
  await expect(views.getByRole("link")).toHaveText(["Summary", "Consumers", "Details"]);
  await expect(views.getByRole("link", { name: "Summary" })).toHaveAttribute("aria-current", "page");
  await expect(dialog.locator(".tr-tiles dt")).toHaveText(["Responses", "Frequency", "Affected consumers", "Endpoints"]);
  await expect(dialog.locator(".tr-tiles .tr-tile__value")).toHaveText(["250", "10.4/h", "2", "2"]);
  await expect(dialog.locator(".tr-tiles .tr-tile__sub")).toHaveText(["3.0% of requests", "over 24 hours", "200 responses to identified consumers", "answered with 404"]);
  await expect(dialog.locator(".er-seen dd")).toHaveText(["Nov 5, 2026, 10:00 AM UTC", "Nov 5, 2026, 10:30 AM UTC"]);
  const freq = dialog.getByRole("img", { name: /404 responses over time/ });
  await expect(freq.locator("g")).toHaveCount(4);
  const freqPlot = dialog.getByRole("group", { name: /^404 responses over time/ });
  await freqPlot.focus();
  await freqPlot.press("End");
  await freqPlot.press("ArrowLeft");
  await expect(dialog.locator(".er-freq .ct-sr")).toHaveText(/404 responses: 90/);

  const a11y = await new AxeBuilder({ page }).include(".er-modal").analyze();
  expect(a11y.violations).toEqual([]);

  await views.getByRole("link", { name: "Consumers" }).click();
  await page.waitForURL(/view=consumers/);
  const after = modal(page, "404 Not Found");
  await expect(after.getByText("50 of 250 responses came from requests without a consumer")).toBeVisible();
  const consumers = after.getByRole("table", { name: "Consumer breakdown" });
  await expect(consumers.getByRole("columnheader")).toHaveText(["Consumer", "Responses", "Share", "Last seen"]);
  await expect(consumers.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["Acme Corp", "140", "56.0%", "Nov 5, 2026, 10:30 AM UTC"]);
  // A consumer without a name shows its id.
  await expect(consumers.locator("tbody tr").nth(1).getByRole("cell").first()).toHaveText("c_globex");

  await after.getByRole("navigation", { name: "Status 404 views" }).getByRole("link", { name: "Details" }).click();
  await page.waitForURL(/view=details/);
  const details = modal(page, "404 Not Found").getByRole("list", { name: "Endpoints" });
  await expect(details.getByRole("listitem")).toHaveCount(2);
  const orders = details.getByRole("listitem").first();
  await expect(orders).toContainText("GET /invoices/{id}");
  await expect(orders).toContainText("210 responses, 2 consumers, last Nov 5, 2026, 10:30 AM UTC");
  await expect(orders).toContainText("No validation errors, no server exceptions");
  await expect(orders.getByRole("link", { name: "Endpoint errors" })).toHaveAttribute("href", "/shop/endpoints/GET/%2Finvoices%2F%7Bid%7D?tab=errors");

  // Escape closes the modal and leaves the code out of the URL.
  await page.keyboard.press("Escape");
  await page.waitForURL((url) => !url.search.includes("code="));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the details tab points at validation errors and server exceptions", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?code=422&view=details`);
  const item = modal(page, "422 Unprocessable Content").getByRole("list", { name: "Endpoints" }).getByRole("listitem");
  await expect(item).toContainText("POST /invoices");
  await expect(item).toContainText("80 with validation errors, no server exceptions");
  await expect(item.getByRole("link", { name: "Endpoint errors" })).toHaveAttribute("href", "/shop/endpoints/POST/%2Finvoices?tab=errors");

  await page.goto(`${PAGE}?code=500&view=details`);
  await expect(modal(page, "500 Internal Server Error").getByRole("listitem")).toContainText("No validation errors, 2 server exceptions");
});

test("marking a status code as expected updates the error rate on every surface", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?code=404&view=details`);
  const dialog = modal(page, "404 Not Found");
  const orders = dialog.getByRole("listitem").filter({ hasText: "GET /invoices/{id}" });

  // Confirmation first; Cancel changes nothing.
  await orders.getByRole("button", { name: "Mark 404 as expected" }).click();
  const confirm = orders.getByRole("group", { name: "Mark 404 as expected for GET /invoices/{id}?" });
  await expect(confirm).toContainText("stop counting as errors on every dashboard, in every app of this project");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  await orders.getByRole("button", { name: "Mark 404 as expected" }).click();
  await orders.getByRole("button", { name: "Mark as expected", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "404 is now expected for GET /invoices/{id}." })).toBeVisible();
  // The modal reads again: only the other endpoint still counts 404 as an error.
  await expect(dialog.getByRole("list", { name: "Endpoints" }).getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("listitem")).toContainText("GET /users/{id}");

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.waitForURL((url) => !url.search.includes("code="));
  await expect(tiles(page).locator(".tr-tile__value")).toHaveText(["8,200", "1.5%", "120", "2"]);
  await expect(page.getByRole("img", { name: /Errors by status class/ })).toHaveAttribute("aria-label", /120 4xx and 2 5xx/);
  await expect(statusTable(page).locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["422 Unprocessable Content", "80", "1.0%", "1", "1", "", "Nov 5, 2026, 10:15 AM UTC"]);
  await expect(statusTable(page).getByRole("row").filter({ hasText: "404 Not Found" }).getByRole("cell").nth(1)).toHaveText("40");

  // Issues no longer list GET /invoices/{id} 404.
  await page.getByRole("navigation", { name: "Error views" }).getByRole("link", { name: "Issues" }).click();
  await page.waitForURL(/tab=issues/);
  const issues = page.getByRole("table", { name: "Issues" });
  await expect(issues.locator("tbody tr")).toHaveCount(3);
  await expect(issues.locator("tbody tr").filter({ hasText: "/invoices/{id}" })).toHaveText([/500/]);

  // The endpoint's own settings now list 404 as expected.
  await page.goto("/shop/endpoints/GET/%2Finvoices%2F%7Bid%7D?tab=errors");
  await page.getByRole("button", { name: "Endpoint settings" }).click();
  await expect(page.getByRole("dialog", { name: "Endpoint settings" }).getByRole("textbox", { name: "Expected status codes" })).toHaveValue("404");
});

test("without capture.manage the modal says who can mark a code as expected", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?code=404&view=details`, { capabilities: ["project.read"] });
  const dialog = modal(page, "404 Not Found");
  await expect(dialog.getByText("Only project admins can mark 404 as expected for this endpoint.").first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Mark 404 as expected/ })).toHaveCount(0);
});

test("Issues tab: failed requests by endpoint and status, each opening the endpoint's errors", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?tab=issues&env=production`);
  const issues = page.getByRole("table", { name: "Issues" });
  await expect(issues.getByRole("columnheader")).toHaveText(["Endpoint", "Status", "Responses", "Consumers", "Last seen"]);
  await expect(issues.locator("tbody tr")).toHaveCount(4);
  await expect(issues.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["GET /invoices/{id}", "404", "210", "2", "Nov 5, 2026, 10:30 AM UTC"]);
  await expect(issues.getByRole("link", { name: "POST /invoices" })).toHaveAttribute("href", "/shop/endpoints/POST/%2Finvoices?tab=errors&env=production");
  const a11y = await new AxeBuilder({ page }).include(".er").analyze();
  expect(a11y.violations).toEqual([]);
});

test("says so when there were no requests or no errors, and when the dashboard cannot load", async ({ page }) => {
  await seed([], []);
  await signIn(page, `${PAGE}?range=1h`);
  await expect(page.getByRole("status").filter({ hasText: "No requests in the last 1 hour." })).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);

  await seed([], [100, 100, 100, 100]);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "No error responses in the last 1 hour." })).toBeVisible();

  await seed(ROWS, [2000, 2200, 1800, 2200], true);
  await page.goto(PAGE);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load errors just now." });
  await expect(alert).toBeVisible();
  await seed();
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(tiles(page).locator(".tr-tile__value").first()).toHaveText("8,200");
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page);
  await expect(statusTable(page).locator("tbody tr")).toHaveCount(3);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto(`${PAGE}?code=404&view=details`);
  await expect(modal(page, "404 Not Found")).toBeVisible();
  const wide = await modal(page, "404 Not Found").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
});

test("screenshots", async ({ page }) => {
  const dir = process.env.ERRORS_SHOTS;
  test.skip(!dir, "set ERRORS_SHOTS to a directory to capture screenshots");
  await seed();
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const [name, url] of [
      ["status", PAGE],
      ["modal", `${PAGE}?code=404`],
      ["details", `${PAGE}?code=404&view=details`],
      ["issues", `${PAGE}?tab=issues`],
    ]) {
      await page.goto(url);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.screenshot({ path: `${dir}/errors-${name}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
