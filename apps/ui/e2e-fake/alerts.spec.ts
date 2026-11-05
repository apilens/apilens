// Alerts (#610) against the fake identity (e2e-fake/fake-identity.ts), which plays the alerts API
// (#609): rules, channels, events and the incidents feed for shop. `/__fake/alerts` plays the
// evaluator (opens and resolves incidents) and resets them. No email is sent by any test here:
// channels are only stored, and test sends are answered by the fake.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";

async function fake(body: Record<string, unknown>) {
  const res = await fetch(`${IDENTITY}/__fake/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", down }) });
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

const badge = (page: Page) => page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: /^Incidents/ }).locator(".ct");

async function addChannel(page: Page, name: string, type: string, fields: Record<string, string>) {
  const form = page.getByRole("form", { name: "Add a channel" });
  await form.getByLabel("Type").selectOption({ label: type });
  await form.getByLabel("Name").fill(name);
  for (const [label, value] of Object.entries(fields)) await form.getByLabel(label).fill(value);
  await form.getByRole("button", { name: "Add channel" }).click();
  await expect(form.getByRole("status")).toHaveText(`Added ${name}.`);
}

test.beforeEach(async () => {
  await fake({ reset: true });
});

test.afterEach(async () => {
  await queryDown(false);
});

test("create a channel and a rule, then see its incident open and resolve", async ({ page }) => {
  await signIn(page, "/shop/settings/alerts");
  await expect(page.getByRole("heading", { level: 1, name: "Alert channels" })).toBeVisible();

  // Channels: add, send a test (accepted and refused), the config is never shown again.
  await addChannel(page, "On-call", "Email", { "Email addresses": "oncall@example.com" });
  await addChannel(page, "Old hook", "Webhook", { URL: "https://hooks.example.com/gone", "Signing secret": "0123456789abcdef" });
  const list = page.getByRole("list", { name: "Alert channels" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await list.getByRole("button", { name: "Send a test notification to On-call" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "On-call" }).getByRole("status")).toHaveText("Test notification queued for sending.");
  await list.getByRole("button", { name: "Send a test notification to Old hook" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "Old hook" }).getByRole("status")).toHaveText(
    "The channel didn’t accept the test notification (HTTP 410). Check its settings.",
  );
  await expect(page.getByText("oncall@example.com")).toHaveCount(0);

  // No incidents yet: no badge.
  await page.goto("/shop/incidents");
  await expect(page.getByRole("status").filter({ hasText: "No open incidents." })).toBeVisible();
  await expect(badge(page)).toHaveCount(0);

  // Create a rule.
  await page.getByRole("link", { name: "Alert rules" }).click();
  await expect(page.getByRole("status").filter({ hasText: "No alert rules yet." })).toBeVisible();
  await page.getByRole("link", { name: "New rule" }).click();
  await page.waitForURL("**/shop/incidents/rules/new");
  const form = page.getByRole("form", { name: "New alert rule" });
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByText("Use a name of 1 to 128 characters.")).toBeVisible();
  await form.getByLabel("Name").fill("Checkout error rate");
  await form.getByLabel("Endpoint").fill("POST /checkout");
  await expect(form.getByLabel("App")).toHaveValue(/.+/);
  await expect(form.getByLabel("Environment")).toHaveValue("production");
  await form.getByLabel("Threshold").fill("2");
  await form.getByLabel("Notify after").fill("2");
  await form.getByRole("checkbox", { name: /On-call/ }).check();
  await form.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
  const rules = page.getByRole("table", { name: "Alert rules" });
  await expect(rules.locator("tbody tr")).toHaveCount(1);
  await expect(rules.locator("tbody tr").first()).toContainText("Checkout error rate");
  await expect(rules.locator("tbody tr").first()).toContainText("Shop · production · POST /checkout");
  await expect(rules.locator("tbody tr").first()).toContainText("Error rate > 2% over 5 min");
  await expect(rules.locator("tbody tr").first()).toContainText("every 1 min");
  await expect(rules.locator("tbody tr").first()).toContainText("On-call");
  await expect(rules.locator("tbody tr").first()).toContainText("Not evaluated yet");

  // The evaluator opens an incident: it shows with its value against the threshold, and the badge counts it.
  await fake({ trigger: { rule: "Checkout error rate", value: 0.034, minutes_ago: 12 } });
  await page.getByRole("link", { name: "Incidents", exact: true }).first().click();
  await page.waitForURL("**/shop/incidents");
  const open = page.getByRole("table", { name: "Open incidents" });
  await expect(open.locator("tbody tr")).toHaveCount(1);
  const row = open.locator("tbody tr").first();
  await expect(row).toContainText("Checkout error rate");
  await expect(row).toContainText("Triggered");
  await expect(row).toContainText("3.4%");
  await expect(row).toContainText("threshold > 2%");
  await expect(row).toContainText("Started 12m ago");
  await expect(row).toContainText(/Ongoing for 1[12] min, notified/);
  await expect(badge(page)).toHaveText("1");

  const a11y = await new AxeBuilder({ page }).include(".al").analyze();
  expect(a11y.violations).toEqual([]);

  // Its timeline.
  await row.getByRole("link", { name: "Checkout error rate" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout error rate" })).toBeVisible();
  const timeline = page.getByRole("list", { name: "Incidents of this rule" });
  await expect(timeline.locator(":scope > li")).toHaveCount(1);
  await expect(timeline).toContainText("Open");
  await expect(timeline).toContainText("Triggered");
  await expect(timeline).toContainText("Notified");

  // Resolved: it moves to Resolved and the badge goes away.
  await fake({ resolve: "Checkout error rate" });
  await page.goto("/shop/incidents");
  await expect(page.getByRole("table", { name: "Open incidents" })).toHaveCount(0);
  const resolved = page.getByRole("table", { name: "Resolved incidents" });
  await expect(resolved.locator("tbody tr")).toHaveCount(1);
  await expect(resolved.locator("tbody tr").first()).toContainText("Resolved after");
  await expect(badge(page)).toHaveCount(0);
});

test("edit a rule, then delete it", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules/new");
  const form = page.getByRole("form", { name: "New alert rule" });
  await form.getByLabel("Name").fill("Slow checkout");
  await form.getByLabel("Metric").selectOption({ label: "p95 response time" });
  await form.getByLabel("Threshold").fill("800");
  await form.getByLabel("On a cron schedule").check();
  await form.getByRole("textbox", { name: "Cron schedule" }).fill("*/5 * * * *");
  await form.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
  const row = page.getByRole("table", { name: "Alert rules" }).locator("tbody tr").first();
  await expect(row).toContainText("p95 response time > 800 ms over 5 min");
  await expect(row).toContainText("cron */5 * * * * (UTC)");

  await row.getByRole("link", { name: "Slow checkout" }).click();
  const edit = page.getByRole("form", { name: "Edit Slow checkout" });
  await expect(edit.getByLabel("Threshold")).toHaveValue("800");
  await expect(edit.getByLabel("App")).toBeDisabled();
  await edit.getByLabel("Threshold").fill("1000");
  await edit.getByLabel(/^Enabled/).uncheck();
  await edit.getByRole("button", { name: "Save rule" }).click();
  await expect(edit.getByRole("status")).toHaveText("Saved Slow checkout.");

  await page.goto("/shop/incidents/rules");
  await expect(row).toContainText("p95 response time > 1 s over 5 min");
  await expect(row).toContainText("Disabled");

  await row.getByRole("link", { name: "Slow checkout" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
  await expect(page.getByRole("status").filter({ hasText: "No alert rules yet." })).toBeVisible();
});

test("members see alerts read-only", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules/new", "member");
  await expect(page.getByText("You can see alerts. Only project admins can change rules and channels.")).toBeVisible();
  await expect(page.getByRole("form", { name: "New alert rule" }).getByLabel("Name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create rule" })).toHaveCount(0);
  await page.goto("/shop/incidents/rules");
  await expect(page.getByRole("link", { name: "New rule" })).toHaveCount(0);
  await page.goto("/shop/settings/alerts");
  await expect(page.getByRole("form", { name: "Add a channel" })).toHaveCount(0);
});

test("says so when the alerts API cannot answer, with a way to try again", async ({ page }) => {
  await signIn(page, "/shop/incidents");
  await queryDown(true);
  await page.reload();
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load incidents just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "No open incidents." })).toBeVisible();
});

test("stacks incidents at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "/shop/incidents/rules/new");
  await page.getByLabel("Name").fill("Errors");
  await page.getByRole("button", { name: "Create rule" }).click();
  await page.waitForURL("**/shop/incidents/rules");
  await fake({ trigger: { rule: "Errors", value: 0.2 } });
  await page.goto("/shop/incidents");
  await expect(page.getByRole("table", { name: "Open incidents" }).locator("tbody tr")).toHaveCount(1);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
