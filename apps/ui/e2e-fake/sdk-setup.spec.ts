// Project settings → SDK setup (#817) against the fake identity (e2e-fake/fake-identity.ts), which
// serves shop's apps (`GET /project`), what their SDKs reported (`GET /apps/{id}/metadata`) and
// when shop's data last arrived (`GET /projects/shop/ingest-status`, seeded by `/__fake/ingested`).
// No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SDK = "/shop/settings/sdk";
const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
/** `APILENS_PUBLIC_INGEST_URL` as the UI renders it (the default). */
const INGEST_URL = "http://localhost:8080";

async function seedApps(apps: Record<string, unknown>[] = []) {
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
}

async function seedIngested(last_at: string | null) {
  await fetch(`${IDENTITY}/__fake/ingested`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", last_at }) });
}

async function signIn(page: Page, capabilities: string[] = ["project.read", "api_keys.create"]) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: SDK, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === SDK);
}

const install = (page: Page) => page.getByRole("region", { name: "Install an SDK" });
const status = (page: Page) => page.getByRole("region", { name: "Status" });

const REPORT = {
  environment: "production",
  framework: "fastapi",
  framework_version: "0.115.0",
  runtime_version: "Python 3.13.1",
  sdk_version: "0.4.0",
  config: {},
  received_at: "2026-11-13T09:30:00Z",
};

test.beforeEach(async () => {
  await seedApps();
  await seedIngested(null);
});

test.afterAll(async () => {
  await seedIngested(null);
});

test("tabs switch the snippets, which carry the key placeholder, app name and ingest URL", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "SDK setup", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "SDK setup" })).toHaveAttribute("aria-current", "page");

  const tabs = install(page).getByRole("tab");
  await expect(tabs).toHaveText(["Python", "Node.js", "Java"]);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  const panel = install(page).getByRole("tabpanel");
  await expect(panel).toContainText("pip install apilenss");
  await expect(panel).toContainText("export APILENS_API_KEY=<your-ingest-key>");
  await expect(panel).toContainText(`base_url="${INGEST_URL}/v1"`);
  await expect(panel).toContainText('app_id="shop"');
  await expect(install(page)).toContainText(INGEST_URL);
  await expect(install(page).getByRole("link", { name: "Create a key in API keys" })).toHaveAttribute("href", "/shop/access/keys");
  await expect(panel.getByRole("link", { name: "Python SDK docs (FastAPI)" })).toHaveAttribute("href", /\/setup-guides\/fastapi$/);
  // Never a stored key.
  await expect(install(page)).not.toContainText("apl_live_");

  // Arrow keys move between tabs.
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(panel).toContainText("npm install apilens-js-sdk");
  await expect(panel.getByRole("link", { name: "Node.js SDK docs (Express)" })).toBeVisible();

  await tabs.nth(2).click();
  await expect(panel).toContainText("apilens.app-id=shop");
  await expect(panel).toContainText(`apilens.base-url=${INGEST_URL}/v1`);

  // Copy a snippet.
  await panel.getByRole("button", { name: "Copy Environment" }).click();
  await expect(panel.getByRole("button", { name: "Copy Environment" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("export APILENS_API_KEY=<your-ingest-key>");
});

test("without api_keys.create the key line asks an admin instead", async ({ page }) => {
  await signIn(page, ["project.read"]);
  await expect(install(page).getByRole("link", { name: "Create a key in API keys" })).toHaveCount(0);
  await expect(install(page)).toContainText("Ask an admin for one");
  await expect(install(page).getByRole("link", { name: "API keys", exact: true })).toHaveAttribute("href", "/shop/access/keys");
});

test("a new app waits for its first request, and refresh shows it once it reports", async ({ page }) => {
  await seedApps([{ id: SHOP, slug: "shop", name: "Shop" }]);
  await signIn(page);
  await expect(status(page)).toContainText("No data received yet.");
  await expect(status(page).getByRole("heading", { name: "Shop", level: 3 })).toBeVisible();
  await expect(status(page)).toContainText("Waiting for the first request.");
  await expect(status(page).getByRole("table")).toHaveCount(0);

  await seedApps([{ id: SHOP, slug: "shop", name: "Shop", environments: [REPORT] }]);
  await seedIngested(new Date(Date.now() - 3 * 60_000).toISOString());
  await status(page).getByRole("button", { name: "Refresh" }).click();
  await expect(status(page)).toContainText(/Last data received [23]m ago\./);
  const table = status(page).getByRole("table", { name: "Shop" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("production");
  await expect(table.getByRole("row").nth(1)).toContainText("fastapi 0.115.0 · Python 3.13.1 · SDK 0.4.0");
  await expect(status(page).getByText("Waiting for the first request.")).toHaveCount(0);
  await expect(status(page).getByRole("button", { name: "Refresh" })).toHaveCount(0);
});
