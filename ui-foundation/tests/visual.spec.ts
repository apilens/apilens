import { expect, test } from "@playwright/test";

const ROUTES = [
  { name: "design", path: "/design" },
  { name: "overview", path: "/projects/checkout-api" },
  { name: "settings-viewer", path: "/projects/partner-sync/settings" },
];

for (const theme of ["dark", "light"] as const) {
  for (const route of ROUTES) {
    test(`${route.name} · ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.goto(route.path);
      await page.waitForLoadState("load");
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page).toHaveScreenshot(`${route.name}-${theme}.png`, { fullPage: true });
    });
  }
}

test("focus ring is visible on primary controls", async ({ page }) => {
  await page.goto("/design");
  const button = page.getByRole("button", { name: "Create API key" }).first();
  await button.focus();
  const outline = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
});
