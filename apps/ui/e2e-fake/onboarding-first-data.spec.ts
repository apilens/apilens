// "Your first requests" (#335) against the fake identity, which also plays the ingest edge and the
// query role: requests sent with the key from the install step show up as rows read through the
// session-based query path (`/api/v1/requests?project=`), with the endpoint count and the p95.
// "Invite your team" goes on to the invite step; "Open project" finishes onboarding on the project.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** The fake identity, which serves the edge's `/v1/requests` too (playwright.fake.config.ts). */
const FAKE_EDGE = "http://127.0.0.1:18080";

/** Signs a new fake user in, walks onboarding to the waiting step and returns the ingest key it showed. */
async function toWaitingStep(page: Page, org: string, project: string): Promise<string> {
  await page.goto("/sign-in");
  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill(org);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await page.getByLabel("Name", { exact: true }).fill(project);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
  await page.getByRole("radio", { name: "Python", exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: /^APILens SDK/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  const key = page.getByRole("textbox", { name: "Ingest key" });
  await expect(key).toHaveValue(/^apl_live_[\w-]+$/);
  const raw = await key.inputValue();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/waiting");
  return raw;
}

/** Sends request records to the fake edge with `key`, as the SDK would. */
async function sendRequests(key: string, appId: string, requests: { method: string; path: string; status_code: number; response_time_ms: number }[]) {
  const res = await fetch(`${FAKE_EDGE}/v1/requests`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: requests.map((r) => ({ app_id: appId, timestamp: Math.floor(Date.now() / 1000), ...r })) }),
  });
  expect(await res.json()).toEqual({ accepted: requests.length });
}

const TRAFFIC = [
  { method: "GET", path: "/orders/42", status_code: 200, response_time_ms: 18 },
  { method: "GET", path: "/orders/43", status_code: 200, response_time_ms: 24 },
  { method: "POST", path: "/orders", status_code: 201, response_time_ms: 61 },
  { method: "GET", path: "/orders/44", status_code: 404, response_time_ms: 9 },
  { method: "GET", path: "/health", status_code: 503, response_time_ms: 140 },
];

/** Walks onboarding to the first data with {@link TRAFFIC} sent. */
async function toFirstData(page: Page, org: string, project: string, appId: string) {
  const raw = await toWaitingStep(page, org, project);
  await sendRequests(raw, appId, TRAFFIC);
  // The waiting screen moves on by itself once the request is in.
  await page.waitForURL((url) => url.pathname === "/onboarding/first-data", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your first requests" })).toBeVisible();
}

test("first data: the latest requests, endpoint count and p95 from the query API; invite your team", async ({ page }) => {
  test.setTimeout(60_000);
  await toFirstData(page, "Pendant", "Pendant API", "pendant-api");

  const table = page.getByRole("table", { name: "Latest requests" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(TRAFFIC.length);
  // Newest first: the last one sent is on top.
  await expect(rows.first()).toContainText("GET");
  await expect(rows.first()).toContainText("/health");
  await expect(rows.first()).toContainText("503");
  await expect(rows.first()).toContainText("140 ms");
  await expect(rows.nth(2)).toContainText("POST");
  await expect(rows.nth(2)).toContainText("201");

  // Requests, endpoints (GET /orders/{id}, POST /orders, GET /health) and p95.
  const facts = page.locator(".fd-facts");
  await expect(facts.getByRole("definition").nth(0)).toHaveText("5");
  await expect(facts.getByRole("definition").nth(1)).toHaveText("3");
  await expect(facts.getByRole("definition").nth(2)).toHaveText("140 ms");

  // A page load reads them again: the rows survive a refresh.
  await page.reload();
  await expect(rows).toHaveCount(TRAFFIC.length);

  await page.getByRole("button", { name: "Invite your team" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/invite");
});

test("first data: open project finishes onboarding on the project's home view", async ({ page }) => {
  test.setTimeout(60_000);
  await toFirstData(page, "Vandelay", "Vandelay Imports", "vandelay-imports");
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForURL((url) => url.pathname === "/vandelay-imports/incidents" && !url.searchParams.has("setup"));
  // Onboarding is finished: its pages now send the user to a project.
  await page.goto("/onboarding/first-data");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
});

test("first data: a failing query API shows a retry, which loads the rows once it answers", async ({ page, request }) => {
  test.setTimeout(60_000);
  await toFirstData(page, "Kramerica", "Kramerica Industries", "kramerica-industries");
  await request.post(`${FAKE_EDGE}/__fake/query-down`, { data: { project: "kramerica-industries", down: true } });
  await page.reload();
  await expect(page.locator(".fd-failed")).toContainText("We couldn’t load your requests just now.");
  await expect(page.getByRole("table")).toHaveCount(0);
  await request.post(`${FAKE_EDGE}/__fake/query-down`, { data: { project: "kramerica-industries", down: false } });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("table", { name: "Latest requests" }).locator("tbody tr")).toHaveCount(TRAFFIC.length);
});

// #335: visual check in light and dark at 1440 and 390 px, axe finding no serious or critical
// violations and no sideways scroll. Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding-first-data`.
test("first data passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(120_000);
  await toFirstData(page, "Del Boca Data", "Del Boca Data", "del-boca-data");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("table", { name: "Latest requests" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad, `${theme} at ${width} px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shots = process.env.AUTH_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/onboarding-first-data-${theme}-${width}.png`, fullPage: true });
    }
  }
});
