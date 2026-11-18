// Nav sections and cross-links (#998) against the fake identity (e2e-fake/fake-identity.ts): the
// rail splits its pages into Monitor / Catalog / Configure with separators, the top bar names the
// page and the open incidents on a phone, and Alert rules links to the alert channels.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** The shell's open-incident count, answered by the test instead of the fake alerts API. */
async function openIncidents(page: Page, open: number) {
  await page.route("**/api/projects/shop/incidents", (route) => route.fulfill({ json: { ok: true, open } }));
}

test("the rail splits its pages into sections", async ({ page }) => {
  await openIncidents(page, 2);
  await signIn(page, "/shop/traffic");
  const pages = page.getByRole("complementary", { name: "Sidebar" }).getByRole("navigation", { name: "Pages" });
  await expect(pages.getByRole("separator")).toHaveCount(2);
  await expect(pages.getByRole("link")).toHaveText([/Incidents\s*2/, "Explore", "Traffic", "Errors", "Performance", "Consumers", "Apps", "Deploys", "Access", "Project settings"]);
  await page.screenshot({ path: test.info().outputPath("rail-sections.png") });
});

test("on a phone the top bar shows the project, the page and the open incidents", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIncidents(page, 3);
  await signIn(page, "/shop/traffic");
  const bar = page.getByRole("banner", { name: "Top bar" });
  await expect(bar.locator(".tb-crumb--view")).toHaveText("Traffic");
  await expect(bar.locator(".tb-crumb--project .tb-name")).not.toBeEmpty();
  const badge = bar.getByRole("link", { name: "3 open incidents" });
  await expect(badge).toHaveText("3");
  await page.screenshot({ path: test.info().outputPath("mobile-bar.png") });

  // The page name follows the nav label; the badge goes to Incidents and keeps the scope.
  await page.goto("/shop/settings?range=7d");
  await expect(bar.locator(".tb-crumb--view")).toHaveText("Project settings");
  await bar.getByRole("link", { name: "3 open incidents" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/incidents");
  expect(new URL(page.url()).searchParams.get("range")).toBe("7d");
  await expect(bar.locator(".tb-crumb--view")).toHaveText("Incidents");
});

test("no open incidents, no badge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIncidents(page, 0);
  await signIn(page, "/shop/apps");
  await expect(page.locator(".tb .tb-crumb--view")).toHaveText("Apps");
  await expect(page.locator(".tb .tb-incidents")).toHaveCount(0);
});

test("Alert rules links to the alert channels", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules");
  await page.locator("header.ph").getByRole("link", { name: "Alert channels" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/settings/alerts");
  await expect(page.locator("header.ph").getByRole("heading", { level: 2, name: "Alert channels" })).toBeVisible();
});
