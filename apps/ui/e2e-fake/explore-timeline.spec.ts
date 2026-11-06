// Explore timeline (#587) against the fake identity (e2e-fake/fake-identity.ts), which counts the
// rows seeded through `/__fake/requests` per bucket for `GET /requests/timeline` and narrows the
// log's seed by from/to. A click on a bar jumps the log (`?at=`), a drag zooms both (`?from=&to=`).
// No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/explore";

type Row = Record<string, unknown>;

// Twelve requests, one every five minutes from 2 to 57 minutes ago: every third a 404, every
// fourth a 502, the rest 200.
const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `r${i}`,
  timestamp: new Date(Date.now() - (2 + i * 5) * 60_000).toISOString(),
  app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  method: i % 2 ? "POST" : "GET",
  path: "/orders/{id}",
  raw_path: `/orders/${1000 + i}`,
  status_code: i % 4 === 3 ? 502 : i % 3 === 2 ? 404 : 200,
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
}));

async function hook(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

const timeline = (page: Page) => page.getByRole("region", { name: "Requests over time" });
const plot = (page: Page) => page.getByRole("group", { name: /^Requests over time:/ });
const bodyRows = (page: Page) => page.getByRole("grid", { name: "Requests" }).locator(".ex-spacer [role=row]");
const param = (page: Page, k: string) => new URL(page.url()).searchParams.get(k);
const between = (from: string | null, to: string | null) =>
  ROWS.filter((r) => {
    const t = Date.parse(String(r.timestamp));
    return (!from || t >= Date.parse(from)) && (!to || t < Date.parse(to));
  }).length;

/** Waits for the plot to be measured, then returns its box. */
async function plotBox(page: Page) {
  await expect(plot(page)).toHaveAttribute("data-measured", /\d+/);
  const box = await plot(page).boundingBox();
  if (!box) throw new Error("plot has no box");
  return box;
}

test.beforeEach(async () => {
  await hook("/__fake/requests", { project: "shop", rows: ROWS });
});

test.afterEach(async () => {
  await hook("/__fake/timeline-down", { project: "shop", down: false });
  await hook("/__fake/requests", { project: "shop", rows: null });
});

test("draws requests over time by status, with a legend and per-bar tooltips", async ({ page }) => {
  await signIn(page);
  await expect(timeline(page)).toBeVisible();
  await expect(timeline(page).getByRole("list", { name: "Requests by status" }).getByRole("listitem")).toHaveText([
    "12 requests",
    "Successful 6",
    "4xx 3",
    "5xx 3",
    "All errors 50.0%",
  ]);
  // The error counts are quick filters for the log.
  await expect(timeline(page).getByRole("link", { name: "5xx 3" })).toHaveAttribute("href", /status=5xx/);
  await expect(plot(page)).toHaveAttribute("aria-label", /^Requests over time: 12 requests from /);
  // One bar per minute of the hour; every seeded request is drawn in its status class.
  await expect(timeline(page).locator(".ex-tl__bar")).toHaveCount(60);
  await expect(timeline(page).locator("rect.ex-tl-ok")).toHaveCount(6);
  await expect(timeline(page).locator("rect.ex-tl-4xx")).toHaveCount(3);
  await expect(timeline(page).locator("rect.ex-tl-5xx")).toHaveCount(3);

  // Hover names the bar's time and split: the newest bar holds the 200 of 2 minutes ago.
  await plotBox(page);
  const newest = await timeline(page).locator("rect.ex-tl-ok").last().boundingBox();
  if (!newest) throw new Error("no bar");
  await page.mouse.move(newest.x + newest.width / 2, newest.y + newest.height / 2);
  await expect(timeline(page).locator(".ex-tl__tip")).toHaveText(/^\d\d:\d\d to \d\d:\d\d UTC: 1 request \(1 successful, 0 4xx, 0 5xx\)$/);
});

test("works in the light and dark themes", async ({ page }) => {
  await signIn(page);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const colors = await timeline(page).evaluate((el) => {
      const fill = (sel: string) => getComputedStyle(el.querySelector(sel) as Element).fill;
      return { bg: getComputedStyle(el).backgroundColor, ok: fill("rect.ex-tl-ok"), c4: fill("rect.ex-tl-4xx"), c5: fill("rect.ex-tl-5xx") };
    });
    // Three distinct fills, none of them the card's own surface.
    expect(new Set([colors.bg, colors.ok, colors.c4, colors.c5]).size).toBe(4);
    const a11y = await new AxeBuilder({ page }).include(".ex-tl").analyze();
    expect(a11y.violations).toEqual([]);
  }
});

test("respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  // The busy fade is the timeline's only motion; the app's global reduced-motion rule leaves 0.01 ms.
  const duration = () => plot(page).evaluate((el) => Number.parseFloat(getComputedStyle(el).transitionDuration));
  expect(await duration()).toBeLessThan(0.001);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await duration()).toBe(0.12);
});

test("a click on a bar shows the log from that time back, and Back to newest returns", async ({ page }) => {
  await signIn(page);
  await expect(bodyRows(page)).toHaveCount(12);
  const box = await plotBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => param(page, "at")).not.toBeNull();
  const at = param(page, "at");
  await expect(bodyRows(page)).toHaveCount(between(null, at));
  await expect(timeline(page).locator(".ex-tl__cursor")).toHaveCount(1);
  await expect(timeline(page).getByText(/^Log from \d\d:\d\d UTC back\./)).toBeVisible();
  // The deep link reproduces it.
  await page.reload();
  await expect(bodyRows(page)).toHaveCount(between(null, at));

  await timeline(page).getByRole("link", { name: "Back to newest" }).click();
  await expect.poll(() => param(page, "at")).toBeNull();
  await expect(bodyRows(page)).toHaveCount(12);
});

test("a drag across bars zooms the timeline and the log, and Reset zoom returns", async ({ page }) => {
  // A filter is on: the zoom keeps it, and so does Reset zoom.
  await signIn(page, `${PAGE}?method=GET`);
  const gets = (from: string | null, to: string | null) =>
    ROWS.filter((r) => {
      const t = Date.parse(String(r.timestamp));
      return r.method === "GET" && (!from || t >= Date.parse(from)) && (!to || t < Date.parse(to));
    }).length;
  await expect(bodyRows(page)).toHaveCount(6);
  const box = await plotBox(page);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, y, { steps: 4 });
  await expect(timeline(page).locator(".ex-tl__sel")).toHaveCount(1);
  await page.mouse.move(box.x + box.width * 0.62, y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => param(page, "to")).not.toBeNull();
  const from = param(page, "from");
  const to = param(page, "to");
  expect(Date.parse(String(to)) - Date.parse(String(from))).toBeGreaterThan(15 * 60_000);
  expect(Date.parse(String(to)) - Date.parse(String(from))).toBeLessThan(23 * 60_000);
  expect(param(page, "method")).toBe("GET");
  const n = gets(from, to);
  expect(n).toBeGreaterThan(0);
  await expect(bodyRows(page)).toHaveCount(n);
  await expect(page.getByText(/^The newest \d+ requests? in the window from \d\d:\d\d to \d\d:\d\d UTC matching the filters, newest first\.$/)).toBeVisible();
  await expect(timeline(page).getByText(/^Zoomed to \d\d:\d\d to \d\d:\d\d UTC\./)).toBeVisible();
  // The zoomed timeline draws finer bars over the window only, counting the same requests.
  expect(await timeline(page).locator(".ex-tl__bar").count()).toBeGreaterThan(30);
  await expect(plot(page)).toHaveAttribute("aria-label", new RegExp(`^Requests over time: ${n} requests? from `));

  await timeline(page).getByRole("link", { name: "Reset zoom" }).click();
  await expect.poll(() => param(page, "from")).toBeNull();
  expect(param(page, "method")).toBe("GET");
  await expect(timeline(page).locator(".ex-tl__bar")).toHaveCount(60);
  await expect(bodyRows(page)).toHaveCount(6);
});

test("zooms and jumps from the keyboard", async ({ page }) => {
  await signIn(page);
  await plotBox(page);
  await plot(page).focus();
  // Focus starts on the newest bar; Shift+Left twice selects three bars.
  await page.keyboard.press("ArrowLeft");
  await expect(timeline(page).locator(".ex-tl__focus")).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(timeline(page).locator(".ex-tl__sr")).toHaveText(/^Selected 3 bars\. /);
  await page.keyboard.press("Enter");
  await expect.poll(() => param(page, "from")).not.toBeNull();
  const span = Date.parse(String(param(page, "to"))) - Date.parse(String(param(page, "from")));
  expect(span).toBe(3 * 60_000);

  await plot(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect.poll(() => param(page, "at")).not.toBeNull();
});

test("a new range starts over without the zoom", async ({ page }) => {
  await signIn(page, `${PAGE}?from=${encodeURIComponent(new Date(Date.now() - 30 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 10 * 60_000).toISOString())}`);
  await expect(timeline(page).getByRole("link", { name: "Reset zoom" })).toBeVisible();
  await page.getByRole("navigation", { name: "Time range" }).getByRole("link", { name: "6h" }).click();
  await expect.poll(() => param(page, "range")).toBe("6h");
  expect(param(page, "from")).toBeNull();
  await expect(timeline(page).getByRole("link", { name: "Reset zoom" })).toHaveCount(0);
});

test("says so when the timeline cannot load, and the log still works", async ({ page }) => {
  await hook("/__fake/timeline-down", { project: "shop", down: true });
  await signIn(page);
  await expect(timeline(page).getByRole("status")).toHaveText("We couldn’t load the timeline just now. The log below still works.");
  await expect(bodyRows(page)).toHaveCount(12);
});

test("fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(plot(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
