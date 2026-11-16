// Project settings section nav (#800) against the fake identity (e2e-fake/fake-identity.ts): the
// sections in order, keyboard movement, `aria-current`, the page title, the "Nothing here yet"
// state, the select on narrow screens and the 404 for unknown sections. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "project.delete"];
const VIEWER = ["project.read"];

async function signIn(page: Page, next: string, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const sectionNav = (page: Page) => page.getByRole("navigation", { name: "Project settings" });

const ALL = ["General", "Environments", "SDK setup", "Capture", "Privacy", "Retention", "Ingest health", "Usage", "Alert channels", "Health checks", "Integrations", "Danger zone"];

test("lists the sections in order, grouped, with the current one marked", async ({ page }) => {
  await signIn(page, "/shop/settings/privacy");
  const nav = sectionNav(page);
  await expect(nav.getByRole("link")).toHaveText(ALL);
  for (const group of ["Project", "Data", "Alerting", "More"]) await expect(nav.getByRole("list", { name: group })).toBeVisible();
  await expect(nav.getByRole("list", { name: "Alerting" }).getByRole("link")).toHaveText(["Alert channels", "Health checks"]);
  await expect(nav.getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "API keys" })).toHaveCount(0);
  await expect(page).toHaveTitle(/^Privacy · Project settings/);
});

test("moves through the sections with the keyboard", async ({ page }) => {
  await signIn(page, "/shop/settings/capture");
  const nav = sectionNav(page);
  await nav.getByRole("link", { name: "Capture" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("link", { name: "Privacy" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(nav.getByRole("link", { name: "SDK setup" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(nav.getByRole("link", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("link", { name: "General" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(nav.getByRole("link", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(nav.getByRole("link", { name: "General" })).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === "/shop/settings/environments");
  await expect(nav.getByRole("link", { name: "Environments" })).toHaveAttribute("aria-current", "page");
});

test("a section not built yet says so instead of a blank page", async ({ page }) => {
  await signIn(page, "/shop/settings/retention");
  await expect(page.getByRole("heading", { level: 1, name: "Retention" })).toBeVisible();
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
  await expect(sectionNav(page).getByRole("link", { name: "Retention" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle(/^Retention · Project settings/);
});

test("the danger zone is listed only with project.delete", async ({ page }) => {
  await signIn(page, "/shop/settings/usage", VIEWER);
  await expect(sectionNav(page).getByRole("link")).toHaveText(ALL.filter((s) => s !== "Danger zone"));
});

test("a select replaces the nav on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "/shop/settings/retention");
  await expect(sectionNav(page)).toBeHidden();
  const pick = page.getByRole("combobox", { name: "Section" });
  await expect(pick).toHaveValue("retention");
  await pick.selectOption({ label: "Health checks" });
  await page.waitForURL((url) => url.pathname === "/shop/settings/health-checks");
});

test("unknown and nested sections are 404", async ({ page }) => {
  await signIn(page, "/shop/settings");
  for (const path of ["/shop/settings/general", "/shop/settings/privacy/x"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
  }
});

// Visual check (light/dark at 1440 and 390): `SETTINGS_NAV_SHOTS=<dir> pnpm test:e2e:fake project-settings-nav`.
test("screenshots", async ({ page }) => {
  const dir = process.env.SETTINGS_NAV_SHOTS;
  test.skip(!dir, "set SETTINGS_NAV_SHOTS to a directory to capture screenshots");
  await signIn(page, "/shop/settings/privacy");
  for (const [name, path] of [
    ["privacy", "/shop/settings/privacy"],
    ["general", "/shop/settings"],
  ]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.goto(path);
        await page.screenshot({ path: `${dir}/settings-${name}-${theme}-${width}.png` });
      }
    }
  }
});
