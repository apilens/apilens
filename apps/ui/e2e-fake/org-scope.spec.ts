// Organization scope (Supabase's `/org/<slug>` pages) against the fake identity
// (e2e-fake/fake-identity.ts): the rail lists only the organization's pages and the top bar has no
// project crumb; opening a project brings both back. Also `/org`, `/organizations` and the old
// `/orgs/<org>/settings` URL. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";

async function signIn(page: Page, next: string, role: "owner" | "admin" | "member" | "viewer" = "owner") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, role }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Pages" });
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Scope" });
const projectSwitcher = (page: Page) => page.getByRole("button", { name: /Switch project$/ });

async function expectOrgScope(page: Page) {
  await expect(rail(page).getByRole("link")).toHaveText(["Projects", "Team", "Organization settings"]);
  await expect(rail(page).getByRole("link", { name: "Incidents" })).toHaveCount(0);
  await expect(projectSwitcher(page)).toHaveCount(0);
  await expect(crumbs(page).getByRole("button", { name: /Organization menu$/ })).toBeVisible();
}

test("org pages show only org links and no project crumb; opening a project brings both back", async ({ page }) => {
  await signIn(page, "/org/acme/general");
  await expectOrgScope(page);
  await expect(rail(page).getByRole("link", { name: "Organization settings" })).toHaveAttribute("aria-current", "page");

  await rail(page).getByRole("link", { name: "Projects" }).click();
  await page.waitForURL((url) => url.pathname === "/org/acme");
  await expectOrgScope(page);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

  await page.getByRole("list", { name: "Projects in Acme" }).getByRole("link").first().click();
  await page.waitForURL((url) => url.pathname.startsWith("/project/shop/"));
  await expect(projectSwitcher(page)).toBeVisible();
  await expect(rail(page).getByRole("link", { name: "Incidents" })).toBeVisible();
  await expect(rail(page).getByRole("link", { name: "Team" })).toHaveCount(0);

  // "All projects" goes back to the organization's projects.
  await projectSwitcher(page).click();
  await page.getByRole("menuitem", { name: "All projects" }).click();
  await page.waitForURL((url) => url.pathname === "/org/acme");
  await expectOrgScope(page);
});

test("the org switcher links all organizations and the org's settings", async ({ page }) => {
  await signIn(page, "/project/shop/incidents");
  await page.getByRole("button", { name: /Organization menu$/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /Acme/ })).toHaveAttribute("href", "/org/acme");
  await expect(page.getByRole("menuitem", { name: "All organizations" })).toHaveAttribute("href", "/organizations");
  await expect(page.getByRole("menuitem", { name: "Organization settings" })).toHaveAttribute("href", "/org/acme/general");
  await page.keyboard.press("Escape");
  // The org crumb's name is the link to its projects.
  await crumbs(page).getByRole("link", { name: /Acme/ }).click();
  await page.waitForURL((url) => url.pathname === "/org/acme");
  await expectOrgScope(page);
});

test("/organizations lists the user's organizations, in org scope", async ({ page }) => {
  await signIn(page, "/organizations");
  await expect(page.getByRole("heading", { level: 1, name: "Your organizations" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Organizations" }).getByRole("link", { name: /Acme/ })).toHaveAttribute("href", "/org/acme");
  await expect(rail(page).getByRole("link")).toHaveText(["Projects", "Team", "Organization settings"]);
  await expect(projectSwitcher(page)).toHaveCount(0);
});

test("/org opens the last project's organization, and old URLs move for good", async ({ page }) => {
  await signIn(page, "/org/acme");
  await page.goto("/org");
  await page.waitForURL((url) => url.pathname === "/org/acme");
  await page.goto("/orgs/acme/settings?x=1");
  await page.waitForURL((url) => url.pathname === "/org/acme/general" && url.searchParams.get("x") === "1");
  await expectOrgScope(page);
  await page.goto("/shop/traffic?range=24h");
  await page.waitForURL((url) => url.pathname === "/project/shop/traffic" && url.searchParams.get("range") === "24h");
  await expect(projectSwitcher(page)).toBeVisible();
});

// Org scope vs project scope, light and dark, 1440 and 390: `ORG_SCOPE_SHOTS=<dir> pnpm test:e2e:fake org-scope`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ORG_SCOPE_SHOTS;
  test.skip(!dir, "set ORG_SCOPE_SHOTS to a directory to capture screenshots");
  await signIn(page, "/org/acme");
  const pages: [string, string][] = [
    ["projects", "/org/acme"],
    ["team", "/org/acme/team"],
    ["general", "/org/acme/general"],
    ["organizations", "/organizations"],
    ["project", "/project/shop/traffic"],
  ];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      for (const [name, path] of pages) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `${dir}/${name}-${theme}-${width}.png`, fullPage: width > 500 });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.goto("/project/shop/traffic");
  await page.getByRole("button", { name: /Organization menu$/ }).click();
  await expect(page.getByRole("menuitem", { name: "All organizations" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/org-switcher-dark.png` });
  await page.keyboard.press("Escape");
  await projectSwitcher(page).click();
  await expect(page.getByRole("menuitem", { name: "All projects" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/project-switcher-dark.png` });
});
