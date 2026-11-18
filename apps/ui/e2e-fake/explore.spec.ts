// Explore request log (#585) and its filters (#586) against the fake identity (e2e-fake/fake-identity.ts), which plays the
// query role: `GET /requests` answers what `/__fake/requests` seeded for shop; `/__fake/query-down`
// makes it answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/project/shop/explore";

type Row = Record<string, unknown>;

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

function row(i: number, extra: Row = {}): Row {
  return {
    timestamp: ago(200 + i * 420),
    app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
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
    trace_id: `t${String(i).padStart(4, "0")}`,
    ...extra,
  };
}

const ROWS = [
  row(0),
  row(1, { method: "POST", path: "/charge", raw_path: "/charge", status_code: 502, response_time_ms: 2480, response_size: 88, consumer_id: "", consumer_name: "" }),
  row(2, { status_code: 404, response_time_ms: 640, sampled: false, response_size: 0, consumer_name: "", consumer_id: "c_beta" }),
];

async function seed(rows: Row[] | null, environments?: string[]) {
  const res = await fetch(`${IDENTITY}/__fake/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", rows, environments }),
  });
  expect(res.status).toBe(204);
}

/** shop's apps (#975); [] puts back the one default app. */
async function seedApps(apps: { id: string; slug: string; name: string }[]) {
  const res = await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
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

const grid = (page: Page) => page.getByRole("grid", { name: "Requests" });
const bodyRows = (page: Page) => grid(page).locator(".ex-spacer [role=row]");
const rowAt = (page: Page, i: number) => grid(page).locator(`[data-index="${i}"]`);

test.afterEach(async () => {
  await queryDown(false);
  await seed(null);
  await seedApps([]);
});

test("shows each request's time, method, path, status, latency, consumer and size", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");

  await expect(grid(page).getByRole("columnheader")).toHaveText(["Time (UTC)", "App", "Method", "Path", "Status", "Latency", "Consumer", "Size"]);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(rowAt(page, 0).getByRole("gridcell")).toHaveText([/^\d\d:\d\d:\d\d\.\d{3}$/, "Shop", "GET", "/orders/1000", "200", "42 ms", "Acme Corp", "1.2 KB"]);
  await expect(rowAt(page, 1).getByRole("gridcell")).toHaveText([/^\d\d:\d\d:\d\d\.\d{3}$/, "Shop", "POST", "/charge", "502", "2.48 s", "–", "88 B"]);
  await expect(rowAt(page, 2).getByRole("gridcell")).toHaveText([/^\d\d:\d\d:\d\d\.\d{3}$/, "Shop", "GET", "/orders/1002Sampled out", "404", "640 ms", "c_beta", "0 B"]);

  // Status and latency carry meaning in color: 4xx and 5xx differ, slow and frustrated differ.
  const color = (sel: string) => grid(page).locator(sel).first().evaluate((el) => getComputedStyle(el).color);
  expect(await color(".ex-status--4xx")).not.toBe(await color(".ex-status--5xx"));
  expect(await color(".ex-status--2xx")).not.toBe(await color(".ex-status--5xx"));
  expect(await color(".ex-lat--slow")).not.toBe(await color(".ex-lat--frustrated"));
  await expect(rowAt(page, 1).locator(".ex-lat--frustrated")).toHaveAttribute("title", "Slower than 2 s");
  await expect(rowAt(page, 0).locator("time")).toHaveAttribute("datetime", String(ROWS[0].timestamp));
  await expect(page.getByText("The newest 3 requests in the last 1 hour, newest first.")).toBeVisible();

  const a11y = await new AxeBuilder({ page }).include(".ex").analyze();
  expect(a11y.violations).toEqual([]);
});

test("renders 200 rows virtualised and scrolls them at frame rate", async ({ page }) => {
  await seed(Array.from({ length: 200 }, (_, i) => row(i)));
  await signIn(page);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "201");
  // Only the rows in view (plus overscan) are in the DOM.
  const rendered = await bodyRows(page).count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(50);

  // Scroll through all 200 rows over ~1 s, a step per frame, timing each frame.
  const frames = await grid(page).evaluate(async (el) => {
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
  const p95 = frames[Math.floor(frames.length * 0.95)];
  console.log(`request log scroll: median frame ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${frames.length} frames`);
  expect(median).toBeLessThan(20);

  await expect(rowAt(page, 199)).toBeVisible();
  await expect(rowAt(page, 0)).toHaveCount(0);
  expect(await bodyRows(page).count()).toBeLessThan(50);
});

test("moves between rows with the keyboard and leaves ⌘K to the switcher", async ({ page }) => {
  await seed(Array.from({ length: 200 }, (_, i) => row(i)));
  await signIn(page);
  // One tab stop for the whole log: the first row.
  await expect(grid(page).locator('[role=row][tabindex="0"]')).toHaveCount(1);
  await rowAt(page, 0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rowAt(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rowAt(page, 0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rowAt(page, 199)).toBeFocused();
  await expect(rowAt(page, 199)).toBeInViewport();
  await page.keyboard.press("PageUp");
  await expect(grid(page).locator(":focus")).toHaveAttribute("data-index", /^1[89]\d$/);
  await page.keyboard.press("Home");
  await expect(rowAt(page, 0)).toBeFocused();
  await expect(rowAt(page, 0)).toHaveAttribute("tabindex", "0");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Switch scope" })).toBeVisible();
});

test("walks back past the newest 200 with Older, live only on the newest page", async ({ page }) => {
  await seed(Array.from({ length: 230 }, (_, i) => row(i, { trace_id: `t${i}`, timestamp: ago(i + 1) })));
  await signIn(page);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "201");
  await expect(page.locator(".ex-foot p")).toHaveText(/^The newest 200 requests/);
  const pages = page.getByRole("navigation", { name: "Request log pages" });
  await pages.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "31");
  await expect(page.locator(".ex-foot p")).toHaveText(/^Requests 201–230 from the newest .* Live updates run on the newest page only\.$/);
  await expect(page.locator(".ex-live__state")).toHaveText("Older page, not live");
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(pages.locator("[aria-disabled=true]", { hasText: "Older" })).toHaveCount(1);

  await page.getByRole("link", { name: "Back to newest" }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "201");
  await expect(page.locator(".ex-live__state")).toHaveText("Live");
});

test("reads the log again every 5 s while live, and not while paused", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(page.locator(".ex-live__state")).toHaveText("Live");

  await seed([row(9, { timestamp: ago(1), raw_path: "/orders/new", trace_id: "tnew" }), ...ROWS]);
  await expect(bodyRows(page)).toHaveCount(4, { timeout: 8_000 });
  await expect(rowAt(page, 0).getByRole("gridcell").nth(3)).toHaveText("/orders/new");

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".ex-live__state")).toHaveText("Paused");
  await seed(Array.from({ length: 6 }, (_, i) => row(i)));
  await page.waitForTimeout(6_000);
  await expect(bodyRows(page)).toHaveCount(4);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(bodyRows(page)).toHaveCount(6, { timeout: 8_000 });
});

test("switches the range, kept in the URL", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  const ranges = page.getByRole("navigation", { name: "Time range" });
  await expect(ranges.getByRole("link", { name: "1h" })).toHaveAttribute("aria-current", "page");
  await ranges.getByRole("link", { name: "24h" }).click();
  await page.waitForURL(/range=24h/);
  await expect(ranges.getByRole("link", { name: "24h" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("The newest 3 requests in the last 24 hours, newest first.")).toBeVisible();
});

test("says so when there are no requests in the range", async ({ page }) => {
  await seed([]);
  await signIn(page, `${PAGE}?range=6h`);
  await expect(page.getByRole("status").filter({ hasText: "No requests in the last 6 hours." })).toBeVisible();
  await expect(grid(page)).toHaveCount(0);
});

test("says so when the query API cannot answer, with a way to try again", async ({ page }) => {
  await seed(ROWS);
  await queryDown(true);
  await signIn(page);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load requests just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(bodyRows(page)).toHaveCount(3);
});

test("keeps the rows it has when a poll fails", async ({ page }) => {
  await seed(ROWS);
  await signIn(page);
  await expect(bodyRows(page)).toHaveCount(3);
  await queryDown(true);
  await expect(page.getByRole("status").filter({ hasText: "Couldn’t refresh the log." })).toBeVisible({ timeout: 8_000 });
  await expect(bodyRows(page)).toHaveCount(3);
});

test("fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(ROWS);
  await signIn(page);
  await expect(bodyRows(page)).toHaveCount(3);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("filters from a deep link, edits them in the bar and keeps them in the URL", async ({ page }) => {
  await seed(ROWS);
  // A shared link reproduces the filtered view: the chips, the form and the rows.
  await signIn(page, `${PAGE}?range=6h&method=POST&status=5xx`);
  const chips = page.getByRole("list", { name: "Active filters" });
  await expect(chips.getByRole("listitem").filter({ hasNot: page.getByRole("button", { name: "Clear all" }) })).toHaveText(["Method POST", "Status 5xx"]);
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(rowAt(page, 0).getByRole("gridcell").nth(3)).toHaveText("/charge");
  await expect(page.getByText("The newest request in the last 6 hours matching the filters, newest first.")).toBeVisible();

  // Status 5xx is a segment of the visible row; only Method sits under More filters.
  await expect(page.getByRole("group", { name: "Status" }).getByRole("button", { name: "5xx" })).toHaveAttribute("aria-pressed", "true");
  const toggle = page.getByRole("button", { name: "More filters (1)" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.getByLabel("Status codes", { exact: true })).toHaveValue("5xx");
  await expect(page.getByLabel("Method", { exact: true })).toHaveValue("POST");

  // The poll reads the same filters: a new GET row does not show up.
  await seed([row(9, { timestamp: ago(1), raw_path: "/orders/new", trace_id: "tnew" }), ...ROWS]);
  await page.waitForTimeout(6_000);
  await expect(bodyRows(page)).toHaveCount(1);

  // An invalid status says why and leaves the URL alone; a valid one applies once typing pauses.
  await page.getByLabel("Status codes", { exact: true }).fill("9xx");
  await expect(page.getByText("Codes (404), classes (4xx) or ranges (500-503)")).toBeVisible();
  await page.waitForTimeout(800);
  expect(new URL(page.url()).searchParams.get("status")).toBe("5xx");
  await page.getByLabel("Status codes", { exact: true }).fill("4XX, 5xx");
  await page.waitForURL((u) => u.searchParams.get("status") === "4xx,5xx");
  await expect(page.getByRole("group", { name: "Status" }).getByRole("button", { name: "Errors" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Method", { exact: true })).toHaveValue("POST");
  expect(new URL(page.url()).searchParams.get("range")).toBe("6h");

  // A picker applies at once.
  await page.getByLabel("Method", { exact: true }).selectOption("GET");
  await page.waitForURL((u) => u.searchParams.get("method") === "GET");
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(rowAt(page, 0).getByRole("gridcell").nth(4)).toHaveText("404");

  // Back and forward move through the filtered views, and the form follows.
  await page.goBack();
  await page.waitForURL((u) => u.searchParams.get("method") === "POST");
  await expect(page.getByLabel("Method", { exact: true })).toHaveValue("POST");
  await expect(page.getByLabel("Status codes", { exact: true })).toHaveValue("4xx,5xx");
  await page.goForward();
  await page.waitForURL((u) => u.searchParams.get("method") === "GET");
  await expect(page.getByLabel("Method", { exact: true })).toHaveValue("GET");

  // Removing a chip clears that filter only; Clear all clears every one.
  await chips.getByRole("button", { name: "Remove filter: Method GET" }).click();
  await page.waitForURL((u) => !u.searchParams.has("method") && u.searchParams.get("status") === "4xx,5xx");
  await expect(page.getByLabel("Method", { exact: true })).toHaveValue("");
  await expect(bodyRows(page)).toHaveCount(2);
  await chips.getByRole("button", { name: "Clear all" }).click();
  await page.waitForURL((u) => u.search === "?range=6h");
  await expect(page.getByRole("list", { name: "Active filters" })).toHaveCount(0);
  await expect(page.getByLabel("Status codes", { exact: true })).toHaveValue("");
  await expect(bodyRows(page)).toHaveCount(4);

  const a11y = await new AxeBuilder({ page }).include(".ex").analyze();
  expect(a11y.violations).toEqual([]);
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

test("Path and Consumer take what the log shows and suggest endpoints and consumers by keyboard", async ({ page }) => {
  await seed(ROWS);
  // The endpoints list (one row per app: the same route twice) and the consumers the fields suggest.
  const endpoint = (method: string, path: string) => ({ app_id: "a", method, path, requests: 1, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 1, p95_ms: 1 });
  await post("/__fake/traffic", {
    project: "shop",
    envs: { "": { summary: {}, points: [], endpoints: [endpoint("GET", "/orders/{id}"), endpoint("POST", "/charge"), endpoint("GET", "/orders/{id}")] } },
  });
  await post("/__fake/consumers", {
    project: "shop",
    consumers: [
      { consumer_id: "c_acme", consumer_name: "Acme Corp", consumer_group: "", requests: 2 },
      { consumer_id: "c_beta", consumer_name: "", consumer_group: "", requests: 1 },
    ],
  });
  try {
    await signIn(page);
    await expect(bodyRows(page)).toHaveCount(3);
    // Search (always in view) takes the path or URL and suggests endpoints and consumers (#985);
    // Consumer sits under More filters.
    await page.getByRole("button", { name: "More filters" }).click();
    const path = page.getByRole("combobox", { name: "Search" });
    const consumer = page.getByRole("combobox", { name: "Consumer" });

    // A raw URL copied from the log finds its request.
    await path.fill("/orders/1002");
    await page.waitForURL((u) => u.searchParams.get("path") === "/orders/1002");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(rowAt(page, 0).getByRole("gridcell").nth(3)).toHaveText("/orders/1002Sampled out");
    await path.press("Escape");
    await path.fill("");
    await page.waitForURL((u) => !u.searchParams.has("path"));

    // A consumer's name, as the Consumer column shows it, finds its requests.
    await consumer.fill("Acme Corp");
    await page.waitForURL((u) => u.searchParams.get("consumer_id") === "Acme Corp");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(rowAt(page, 0).getByRole("gridcell").nth(6)).toHaveText("Acme Corp");
    await consumer.press("Escape");
    await expect(consumer).toHaveAttribute("aria-expanded", "false");

    // Suggestions by keyboard: ↓ opens and moves, Enter picks; the route sets method and path.
    await path.focus();
    await path.press("ArrowDown");
    const paths = page.getByRole("listbox", { name: "Search suggestions" });
    await expect(path).toHaveAttribute("aria-expanded", "true");
    await expect(paths.getByRole("option")).toHaveText(["GET/orders/{id}", "POST/charge", "ConsumerAcme Corpc_acme", "Consumerc_beta"]);
    await path.pressSequentially("char");
    await expect(paths.getByRole("option")).toHaveText(["POST/charge"]);
    await path.press("ArrowDown");
    await expect(paths.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(path).toHaveAttribute("aria-activedescendant", (await paths.getByRole("option").first().getAttribute("id")) ?? "");
    await path.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("path") === "/charge" && u.searchParams.get("method") === "POST");
    await expect(path).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("Method", { exact: true })).toHaveValue("POST");

    // A consumer picked by name filters by its id; the chip reads its name, as the log does.
    await page.getByRole("list", { name: "Active filters" }).getByRole("button", { name: "Clear all" }).click();
    await page.waitForURL((u) => u.search === "");
    await consumer.focus();
    await consumer.pressSequentially("acme");
    const consumers = page.getByRole("listbox", { name: "Consumer suggestions" });
    await expect(consumers.getByRole("option")).toHaveText(["Acme Corpc_acme"]);
    const a11y = await new AxeBuilder({ page }).include(".ex-filters").analyze();
    expect(a11y.violations).toEqual([]);
    await consumer.press("ArrowDown");
    await consumer.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("consumer_id") === "c_acme");
    await expect(consumer).toHaveValue("c_acme");
    await expect(page.getByRole("list", { name: "Active filters" }).getByRole("listitem").first()).toHaveText("Consumer Acme Corp");
    await expect(bodyRows(page)).toHaveCount(1);
  } finally {
    await post("/__fake/traffic", { project: "shop", envs: {} });
    await post("/__fake/consumers", { project: "shop", consumers: [] });
  }
});

test("the visible row filters by Status segment, search, environment and app; 5xx rows are tinted (#985)", async ({ page }) => {
  await seed(ROWS, ["production", "staging"]);
  await post("/__fake/consumers", { project: "shop", consumers: [{ consumer_id: "c_acme", consumer_name: "Acme Corp", consumer_group: "", requests: 2 }] });
  try {
    await signIn(page);
    await expect(bodyRows(page)).toHaveCount(3);

    // Search, Status, Environment and App are in view without opening anything.
    const status = page.getByRole("group", { name: "Status" });
    await expect(status.getByRole("button")).toHaveText(["All", "Errors", "4xx", "5xx"]);
    await expect(status.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("combobox", { name: "Search" })).toBeVisible();
    await expect(page.getByLabel("Environment", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "More filters" })).toHaveAttribute("aria-expanded", "false");

    // A failed (5xx) row carries a faint tint; a successful one does not.
    const bg = (i: number) => rowAt(page, i).evaluate((el) => getComputedStyle(el).backgroundColor);
    const ok = await bg(0);
    const failed = await bg(1);
    expect(failed).not.toBe(ok);
    expect(failed).not.toBe("rgba(0, 0, 0, 0)");

    // Errors: 4xx and 5xx only, in the URL and the legend's quick filter agrees.
    await status.getByRole("button", { name: "Errors" }).click();
    await page.waitForURL((u) => u.searchParams.get("status") === "4xx,5xx");
    await expect(bodyRows(page)).toHaveCount(2);
    await expect(status.getByRole("button", { name: "Errors" })).toHaveAttribute("aria-pressed", "true");
    await expect(status.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".ex-tl__quick[aria-current=true]")).toContainText("All errors");
    // 5xx narrows to the server error.
    await status.getByRole("button", { name: "5xx" }).click();
    await page.waitForURL((u) => u.searchParams.get("status") === "5xx");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(rowAt(page, 0).getByRole("gridcell").nth(5)).toHaveText("502");
    // A code typed under More filters is no segment, and counts on the More filters button.
    await page.goto(`${PAGE}?status=404`);
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(status.getByRole("button", { pressed: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
    // All clears it.
    await status.getByRole("button", { name: "All" }).click();
    await page.waitForURL((u) => !u.searchParams.has("status"));
    await expect(bodyRows(page)).toHaveCount(3);

    // Search picks a consumer by name.
    const search = page.getByRole("combobox", { name: "Search" });
    await search.focus();
    await search.pressSequentially("acme");
    await expect(page.getByRole("listbox", { name: "Search suggestions" }).getByRole("option")).toHaveText(["ConsumerAcme Corpc_acme"]);
    await search.press("ArrowDown");
    await search.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("consumer_id") === "c_acme" && !u.searchParams.has("path"));
    await expect(search).toHaveValue("");
    await expect(bodyRows(page)).toHaveCount(1);

    // Environment applies at once.
    await page.getByLabel("Environment", { exact: true }).selectOption("staging");
    await page.waitForURL((u) => u.searchParams.get("env") === "staging");

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      await page.goto(`${PAGE}?status=4xx,5xx`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(bodyRows(page)).toHaveCount(2);
      const a11y = await new AxeBuilder({ page }).include(".ex").analyze();
      expect(a11y.violations).toEqual([]);
    }
  } finally {
    await post("/__fake/consumers", { project: "shop", consumers: [] });
  }
});

test("says so when no request matches the filters, with a way to clear them", async ({ page }) => {
  await seed(ROWS);
  await signIn(page, `${PAGE}?path=%2Fnowhere`);
  const status = page.getByRole("status").filter({ hasText: "No requests in the last 1 hour match these filters." });
  await expect(status).toBeVisible();
  await status.getByRole("link", { name: "Clear all filters" }).click();
  await page.waitForURL((u) => u.search === "");
  await expect(bodyRows(page)).toHaveCount(3);
});

test("filters by app, names each row's app and keeps the app in the URL", async ({ page }) => {
  const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const BILLING = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
  await seedApps([
    { id: SHOP, slug: "shop", name: "Shop" },
    { id: BILLING, slug: "billing", name: "Billing" },
  ]);
  await seed(
    [
      row(0),
      row(1, { id: "req-billing", app_id: BILLING, method: "POST", path: "/invoices", raw_path: "/invoices", environment: "staging" }),
      row(2, { app_id: "00000000-0000-4000-8000-000000000000" }),
    ],
    ["production", "staging"],
  );
  await signIn(page);

  // The App column names the app (never its id); with two environments the Env column shows too.
  await expect(grid(page).getByRole("columnheader")).toHaveText(["Time (UTC)", "App", "Env", "Method", "Path", "Status", "Latency", "Consumer", "Size"]);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(rowAt(page, 0).getByRole("gridcell").nth(1)).toHaveText("Shop");
  await expect(rowAt(page, 1).getByRole("gridcell").nth(1)).toHaveText("Billing");
  await expect(rowAt(page, 1).getByRole("gridcell").nth(2)).toHaveText("staging");
  // An app the project no longer lists is a dash, not an id.
  await expect(rowAt(page, 2).getByRole("gridcell").nth(1)).toHaveText("–");
  await expect(grid(page)).not.toContainText(BILLING);

  // The picker lists the project's apps and applies at once.
  // The App picker is in view, no need to open More filters (#985).
  const picker = page.getByLabel("App", { exact: true });
  await expect(picker.locator("option")).toHaveText(["All apps", "Shop", "Billing"]);
  await picker.selectOption({ label: "Billing" });
  await page.waitForURL((u) => u.searchParams.get("app") === BILLING);
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(rowAt(page, 0).getByRole("gridcell").nth(4)).toHaveText("/invoices");
  const chips = page.getByRole("list", { name: "Active filters" });
  await expect(chips.getByRole("listitem").filter({ hasNot: page.getByRole("button", { name: "Clear all" }) })).toHaveText(["App Billing"]);

  // The request drawer names the app too.
  await rowAt(page, 0).click();
  await expect(page.getByRole("dialog").locator(".rd-dl")).toContainText("AppBilling");
  await page.keyboard.press("Escape");

  // The URL round-trips the filter: a fresh load of the link reproduces it.
  const link = page.url();
  await page.goto(link);
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(chips.getByRole("listitem").filter({ hasNot: page.getByRole("button", { name: "Clear all" }) })).toHaveText(["App Billing"]);
  await expect(page.getByRole("button", { name: "More filters", exact: true })).toBeVisible();
  await expect(page.getByLabel("App", { exact: true })).toHaveValue(BILLING);

  // Removing the chip shows every app again.
  await chips.getByRole("button", { name: "Remove filter: App Billing" }).click();
  await page.waitForURL((u) => !u.searchParams.has("app"));
  await expect(bodyRows(page)).toHaveCount(3);

  const a11y = await new AxeBuilder({ page }).include(".ex").analyze();
  expect(a11y.violations).toEqual([]);
});
