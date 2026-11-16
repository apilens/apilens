// An incident drills down (#979) against the fake identity: its action row opens Explore on the
// rule's failing requests (app, environment, status class, endpoint, from the incident's start),
// the Errors page and the endpoint in the same scope, the Scope names the app with a link to it,
// and project admins disable the rule from there. `/__fake/alerts` plays the evaluator. No email
// is sent here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SHOP_APP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

async function fake(body: Record<string, unknown>) {
  const res = await fetch(`${IDENTITY}/__fake/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string, role?: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...(role ? { role } : {}) }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** Creates a rule as an admin and opens one incident of it 20 minutes ago. */
async function ruleWithIncident(page: Page, name: string, metric: string, endpoint?: string) {
  await page.goto("/shop/incidents/rules/new");
  const form = page.getByRole("form", { name: "New alert rule" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Metric").selectOption({ label: metric });
  await form.getByLabel("Threshold").fill("1");
  if (endpoint) await form.getByLabel("Endpoint").fill(endpoint);
  await form.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
  await fake({ trigger: { rule: name, value: 0.2, minutes_ago: 20 } });
}

const params = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const actions = (page: Page) => page.getByRole("group", { name: "Incident actions" });

test.beforeEach(async () => {
  await fake({ reset: true });
});

test("an incident links to its failing requests, Errors, the endpoint and the app", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules/new");
  await ruleWithIncident(page, "Checkout 5xx", "Server error rate (5xx)", "POST /checkout");
  await page.goto("/shop/incidents");
  await page.getByRole("link", { name: "Checkout 5xx" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout 5xx" })).toBeVisible();
  const incident = page.url();
  // Screenshots for review: `INCIDENT_SHOTS=<dir> pnpm test:e2e:fake incident-links`.
  const shots = process.env.INCIDENT_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/incident-links.png`, fullPage: true });

  // Explore: the rule's app, environment, 5xx and endpoint, from the incident's start.
  await actions(page).getByRole("link", { name: "See failing requests" }).click();
  await page.waitForURL("**/shop/explore?**");
  const q = params(page);
  // 1h is Explore's default range, so the link leaves it out.
  expect(q.range).toBeUndefined();
  expect(q).toMatchObject({ env: "production", app: SHOP_APP, status: "5xx", method: "POST", path: "/checkout" });
  const from = Date.parse(q.from);
  expect(Date.now() - from).toBeGreaterThan(19 * 60_000);
  expect(Date.now() - from).toBeLessThan(22 * 60_000);
  await expect(page.getByRole("list", { name: "Active filters" })).toContainText("App Shop");

  // Errors, in the rule's environment and the range holding the incident.
  await page.goto(incident);
  await actions(page).getByRole("link", { name: "Open in Errors" }).click();
  await page.waitForURL("**/shop/errors?**");
  expect(params(page)).toMatchObject({ range: "1h", env: "production" });

  // The endpoint's page, scoped to the app.
  await page.goto(incident);
  await actions(page).getByRole("link", { name: "Endpoint" }).click();
  await page.waitForURL("**/shop/endpoints/POST/**");
  expect(new URL(page.url()).pathname).toBe(`/shop/endpoints/POST/${encodeURIComponent("/checkout")}`);
  expect(params(page)).toMatchObject({ range: "1h", env: "production", app: SHOP_APP });

  // The Scope's app name opens the app.
  await page.goto(incident);
  await page.locator(".al-summary").getByRole("link", { name: "Shop" }).click();
  await page.waitForURL("**/shop/apps/shop");
});

test("a client error rule reads 4xx, and a rule without an endpoint has no Endpoint link", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules/new");
  await ruleWithIncident(page, "Bad requests", "Client errors (4xx)");
  await page.goto("/shop/incidents");
  await page.getByRole("link", { name: "Bad requests" }).first().click();
  await expect(actions(page).getByRole("link", { name: "Endpoint" })).toHaveCount(0);
  await actions(page).getByRole("link", { name: "See failing requests" }).click();
  await page.waitForURL("**/shop/explore?**");
  const q = params(page);
  expect(q).toMatchObject({ env: "production", app: SHOP_APP, status: "4xx" });
  expect(q.method).toBeUndefined();
  expect(q.path).toBeUndefined();
});

test("admins disable and enable the rule from its incident; members do not see it", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules/new");
  await ruleWithIncident(page, "Checkout 5xx", "Server error rate (5xx)");
  await page.goto("/shop/incidents");
  await page.getByRole("link", { name: "Checkout 5xx" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout 5xx" })).toBeVisible();
  const incident = page.url();
  const status = page.locator(".al-summary > div").filter({ hasText: "Status" });

  await actions(page).getByRole("button", { name: "Disable rule" }).click();
  await expect(status).toContainText("Disabled");
  await expect(actions(page).getByRole("button", { name: "Enable rule" })).toBeVisible();
  await actions(page).getByRole("button", { name: "Enable rule" }).click();
  await expect(actions(page).getByRole("button", { name: "Disable rule" })).toBeVisible();
  await expect(status).not.toContainText("Disabled");

  const path = new URL(incident).pathname;
  await page.context().clearCookies();
  await signIn(page, path, "member");
  await expect(page.getByRole("heading", { level: 1, name: "Checkout 5xx" })).toBeVisible();
  await expect(actions(page).getByRole("link", { name: "See failing requests" })).toBeVisible();
  await expect(actions(page).getByRole("button", { name: /(Disable|Enable) rule/ })).toHaveCount(0);
});
