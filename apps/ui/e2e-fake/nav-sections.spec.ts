// Nav sections and cross-links (#998) against the fake identity (e2e-fake/fake-identity.ts): the
// sidebar groups its pages under Monitor / Catalog / Configure, the mobile bar names the project,
// the page and the open incidents, and Alert rules links to the alert channels.
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

test("the sidebar groups its pages under section headings", async ({ page }) => {
  await openIncidents(page, 2);
  await signIn(page, "/shop/traffic");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("navigation", { name: "Views" })).toMatchAriaSnapshot(`
    - navigation "Views":
      - group "Monitor":
        - heading "Monitor" [level=2]
        - link /Incidents 2/
        - link "Explore"
        - link "Traffic"
        - link "Errors"
        - link "Performance"
        - link "Consumers"
      - group "Catalog":
        - heading "Catalog" [level=2]
        - link "Apps"
        - link "Deploys"
  `);
  await expect(sidebar.getByRole("navigation", { name: "Settings" })).toMatchAriaSnapshot(`
    - navigation "Settings":
      - group "Configure":
        - heading "Configure" [level=2]
        - link "Access"
        - link "Project settings"
  `);
  await page.screenshot({ path: test.info().outputPath("sidebar-sections.png") });

  // Collapsed to a rail, the headings give way to dividers; the rows keep their names.
  await page.keyboard.press("[");
  await expect(sidebar.getByRole("heading", { name: "Monitor" })).toBeHidden();
  await expect(sidebar.getByRole("link", { name: "Traffic" })).toBeVisible();
  await page.keyboard.press("[");
});

test("the mobile bar shows the project, the page and the open incidents", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIncidents(page, 3);
  await signIn(page, "/shop/traffic");
  const bar = page.locator(".app-mobilebar");
  await expect(bar.locator(".mb-ctx")).toHaveText(/Traffic$/);
  await expect(bar.locator(".mb-view")).toHaveText("Traffic");
  await expect(bar.locator(".mb-scope")).not.toBeEmpty();
  const badge = bar.getByRole("link", { name: "3 open incidents" });
  await expect(badge).toHaveText("3");
  await page.screenshot({ path: test.info().outputPath("mobile-bar.png") });

  // The page name follows the nav label; the badge goes to Incidents and keeps the scope.
  await page.goto("/shop/settings?range=7d");
  await expect(bar.locator(".mb-view")).toHaveText("Project settings");
  await bar.getByRole("link", { name: "3 open incidents" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/incidents");
  expect(new URL(page.url()).searchParams.get("range")).toBe("7d");
  await expect(bar.locator(".mb-view")).toHaveText("Incidents");
});

test("no open incidents, no badge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIncidents(page, 0);
  await signIn(page, "/shop/apps");
  await expect(page.locator(".app-mobilebar .mb-view")).toHaveText("Apps");
  await expect(page.locator(".app-mobilebar .mb-badge")).toHaveCount(0);
});

test("Alert rules links to the alert channels", async ({ page }) => {
  await signIn(page, "/shop/incidents/rules");
  await page.locator("header.ph").getByRole("link", { name: "Alert channels" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/settings/alerts");
  await expect(page.locator("header.ph").getByRole("heading", { level: 2, name: "Alert channels" })).toBeVisible();
});
