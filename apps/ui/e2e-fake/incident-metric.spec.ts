// The incident detail's metric chart (#980) against the fake identity: the rule's metric over its
// app's traffic (`GET /traffic/timeseries?app=`, seeded per app by `/__fake/apps`), the threshold
// dashed and the incident shaded. `/__fake/alerts` plays the evaluator. No email is sent here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SHOP_APP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const BUCKET_MS = 1_800_000; // the fake answers app-scoped series in 30 min buckets

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** Six hours of shop's traffic: 120 requests a bucket at 200 ms, the last hour 60 of them 5xx at 900 ms. */
function points() {
  const start = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS - 11 * BUCKET_MS;
  return Array.from({ length: 12 }, (_, k) => {
    const bad = k >= 10;
    return { ts: new Date(start + k * BUCKET_MS).toISOString(), requests: 120, client_errors: 0, server_errors: bad ? 60 : 0, p95_ms: bad ? 900 : 200 };
  });
}

async function createRule(page: Page, name: string, metric: string, threshold: string, condition?: string) {
  await page.goto("/project/shop/incidents/rules/new");
  const form = page.getByRole("form", { name: "New alert rule" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Metric").selectOption({ label: metric });
  // Picking a metric brings its default condition (#982): Requests start at "is below".
  if (condition) await form.getByLabel("When it").selectOption({ label: condition });
  await form.getByLabel("Threshold").fill(threshold);
  await form.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
}

test.beforeEach(async () => {
  await post("/__fake/alerts", { reset: true });
  await post("/__fake/apps", { apps: [{ id: SHOP_APP, slug: "shop", name: "Shop", traffic: { points: points() } }] });
});

test.afterEach(async () => {
  await post("/__fake/apps", { apps: [] });
});

const CASES = [
  { metric: "Errors (4xx + 5xx)", threshold: "5", heading: "Errors (4xx + 5xx) over the last 6 hours", read: "Errors (4xx + 5xx) per 5 min: 10, Threshold: > 5" },
  { metric: "Error rate (4xx + 5xx)", threshold: "5", heading: "Error rate (4xx + 5xx) over the last 6 hours", read: "Error rate (4xx + 5xx): 50.0%, Threshold: > 5.0%" },
  { metric: "p95 response time", threshold: "500", heading: "p95 response time over the last 6 hours", read: "p95 response time: 900 ms, Threshold: > 500 ms" },
  { metric: "Requests", condition: "is above", threshold: "15", heading: "Requests over the last 6 hours", read: "Requests per 5 min: 20, Threshold: > 15" },
];

for (const c of CASES) {
  test(`charts ${c.metric} against its threshold with the incident shaded`, async ({ page }) => {
    await signIn(page, "/project/shop/incidents/rules/new");
    await createRule(page, `${c.metric} rule`, c.metric, c.threshold, "condition" in c ? c.condition : undefined);
    await post("/__fake/alerts", { trigger: { rule: `${c.metric} rule`, value: 1, minutes_ago: 50 } });
    await page.goto("/project/shop/incidents");
    await page.getByRole("link", { name: `${c.metric} rule` }).click();

    await expect(page.getByRole("heading", { level: 2, name: c.heading })).toBeVisible();
    const chart = page.getByRole("group", { name: /over the last 6 hours, peak .*, threshold .*, 1 incident shaded\./ });
    await expect(chart).toBeVisible();
    await expect(page.locator(".al-metric .al-threshold")).toHaveCount(1);
    await expect(page.locator(".al-metric rect.al-band[data-open]")).toHaveCount(1);
    // The newest bucket reads its value against the threshold.
    await chart.focus();
    await chart.press("End");
    await expect(page.locator(".al-metric .ct-sr")).toContainText(c.read);
    // The per-incident history stays below.
    await expect(page.getByRole("list", { name: "Incidents of this rule" }).locator(":scope > li")).toHaveCount(1);
    // Screenshots for review: `INCIDENT_SHOTS=<dir> pnpm test:e2e:fake incident-metric`.
    const shots = process.env.INCIDENT_SHOTS;
    if (shots) await page.screenshot({ path: `${shots}/incident-${c.metric.split(" ")[0].toLowerCase()}.png`, fullPage: true });
  });
}

test("a metric without a series says so instead of charting", async ({ page }) => {
  await signIn(page, "/project/shop/incidents/rules/new");
  await createRule(page, "Apdex rule", "Apdex", "0.8");
  await post("/__fake/alerts", { trigger: { rule: "Apdex rule", value: 0.5, minutes_ago: 5 } });
  await page.goto("/project/shop/incidents");
  await page.getByRole("link", { name: "Apdex rule" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Apdex has no series over time yet" })).toBeVisible();
  await expect(page.locator(".al-metric")).toHaveCount(0);
});
