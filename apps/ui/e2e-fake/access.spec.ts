// Access page shell (#801) against the fake identity (e2e-fake/fake-identity.ts): the Members, API
// keys and Activity tabs, deep links, `aria-current`, the page title, Activity only with
// `audit.read` (a direct link without it shows the not-allowed state), and the permanent redirect from the old `/settings/keys`. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const VIEWER = ["project.read"];

async function signIn(page: Page, next: string, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities, api_keys: [{ name: "Production backend", prefix: "apl_live_Q2x9aZ1", scopes: ["ingest"], created_at: "2026-10-01T10:00:00Z" }] }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Access", exact: true });

test("opens on Members with every tab for an admin", async ({ page }) => {
  await signIn(page, "/shop/access");
  await expect(tabs(page).getByRole("link")).toHaveText(["Members", "API keys", "Activity"]);
  await expect(tabs(page).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  await expect(tabs(page).locator("[aria-current]")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page).toHaveTitle(/^Access · shop/);
});

test("deep links open each tab and the tabs link to each other", async ({ page }) => {
  await signIn(page, "/shop/access/keys");
  await expect(tabs(page).getByRole("link", { name: "API keys" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "API keys" }).locator("tbody tr.pk-row")).toHaveCount(1);
  await expect(page).toHaveTitle(/^Access · shop/);

  await page.goto("/shop/access/activity");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(tabs(page).getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");

  await tabs(page).getByRole("link", { name: "Members" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/access");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
});

test("the old /settings/keys redirects permanently to Access › API keys, keeping the query", async ({ page }) => {
  await signIn(page, "/shop/access");
  const res = await page.request.get("/shop/settings/keys?page=2", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toBe("/shop/access/keys?page=2");
  await page.goto("/shop/settings/keys");
  await page.waitForURL((url) => url.pathname === "/shop/access/keys");
  await expect(tabs(page).getByRole("link", { name: "API keys" })).toHaveAttribute("aria-current", "page");
});

test("a viewer sees Members and API keys read-only and no Activity tab", async ({ page }) => {
  await signIn(page, "/shop/access", VIEWER);
  await expect(tabs(page).getByRole("link")).toHaveText(["Members", "API keys"]);
  await tabs(page).getByRole("link", { name: "API keys" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/access/keys");
  await expect(page.getByText("You can see this project’s keys but not change them.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await page.goto("/shop/access/activity");
  await expect(page.getByRole("heading", { name: "You can’t see this project’s activity log" })).toBeVisible();
});

test("unknown and nested tabs are 404", async ({ page }) => {
  await signIn(page, "/shop/access");
  for (const path of ["/shop/access/members", "/shop/access/keys/x"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
  }
});

// Visual check (light/dark at 1440 and 390): `ACCESS_SHOTS=<dir> pnpm test:e2e:fake access`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ACCESS_SHOTS;
  test.skip(!dir, "set ACCESS_SHOTS to a directory to capture screenshots");
  await signIn(page, "/shop/access");
  for (const [name, path] of [
    ["members", "/shop/access"],
    ["keys", "/shop/access/keys"],
  ]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.goto(path);
        await page.screenshot({ path: `${dir}/access-${name}-${theme}-${width}.png` });
      }
    }
  }
});
