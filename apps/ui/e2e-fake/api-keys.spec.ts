// Access › API keys (#350, #801) against the fake identity (e2e-fake/fake-identity.ts), which
// serves `GET|POST|DELETE /projects/shop/api-keys` (and PUT .../access) and answers 403 to a user without the
// `api_keys.create` / `api_keys.revoke` capability. No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const KEYS = "/shop/access/keys";
const MANAGE = ["project.read", "api_keys.create", "api_keys.revoke"];

async function signIn(page: Page, opts: { capabilities?: string[]; apiKeys?: Record<string, unknown>[] } = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: KEYS, capabilities: opts.capabilities ?? MANAGE, api_keys: opts.apiKeys ?? [] }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === KEYS);
}

const card = (page: Page) => page.getByRole("region", { name: "API keys" });
const rows = (page: Page) => card(page).locator("tbody tr.pk-row");
const dialog = (page: Page) => page.getByRole("dialog");

const SEEDED = [
  {
    name: "Production backend",
    prefix: "apl_live_Q2x9aZ1",
    scopes: ["ingest"],
    created_at: "2026-10-01T10:00:00Z",
    last_used_at: "2026-10-02T10:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  },
  { name: "Analytics script", prefix: "apl_live_r8Lm0Pq", scopes: ["ingest", "read"], created_at: "2026-09-01T10:00:00Z" },
  { name: "Old staging", prefix: "apl_live_k3Vn7Ws", scopes: ["read"], created_at: "2026-08-01T10:00:00Z", revoked_at: "2026-08-15T10:00:00Z" },
  { name: "Trial", prefix: "apl_live_t1Xb4Yc", scopes: ["ingest"], created_at: "2026-07-01T10:00:00Z", expires_at: "2026-07-31T00:00:00Z" },
];

test("lists keys with their prefix, scopes, dates and status", async ({ page }) => {
  await signIn(page, { apiKeys: SEEDED });
  await expect(card(page).getByRole("columnheader")).toHaveText(["Name", "Key", "Permissions", "Apps", "Last used", "Status", "Actions"]);
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0).getByRole("cell")).toHaveText([
    "Production backendCreated Oct 1, 2026",
    "apl_live_Q2x9aZ1…",
    "Ingest · Can create apps",
    "All appsNo data sent yet",
    "Oct 2, 2026",
    "ActiveExpires Jan 1, 2099",
    "Edit accessRevoke",
  ]);
  await expect(rows(page).nth(1).getByRole("cell")).toHaveText([
    "Analytics scriptCreated Sep 1, 2026",
    "apl_live_r8Lm0Pq…",
    "Ingest, Read · Can create apps",
    "All appsNo data sent yet",
    "Never",
    "Active",
    "Edit accessRevoke",
  ]);
  // A revoked key cannot be revoked again; an expired one still can.
  await expect(rows(page).nth(2).getByRole("cell")).toHaveText(["Old stagingCreated Aug 1, 2026", "apl_live_k3Vn7Ws…", "Read", "Doesn’t send data", "Never", "Revoked", ""]);
  await expect(rows(page).nth(3).getByRole("cell").nth(5)).toHaveText("Expired");
  await expect(rows(page).nth(3).getByRole("button", { name: "Revoke Trial" })).toBeEnabled();
});

test("creates a key and shows it once with copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);

  await expect(card(page).getByRole("heading", { name: "No API keys yet" })).toBeVisible();
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Create API key" })).toBeVisible();
  const name = dialog(page).getByRole("textbox", { name: /Name/ });
  await expect(name).toBeFocused();

  // Checked in the browser before anything is sent.
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  await expect(dialog(page).getByText("Enter a name.")).toBeVisible();
  await name.fill("Production backend");
  await dialog(page).getByRole("checkbox", { name: /Ingest/ }).uncheck();
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Choose what the key may do.");
  await dialog(page).getByRole("checkbox", { name: /Ingest/ }).check();
  await dialog(page).getByRole("checkbox", { name: /Read/ }).check();
  await dialog(page).getByRole("combobox", { name: /Expires/ }).selectOption("90");
  await dialog(page).getByRole("button", { name: "Create key" }).click();

  // The one-time reveal: Escape does not dismiss it; Copy puts the full key on the clipboard.
  await expect(dialog(page).getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  const field = dialog(page).getByRole("textbox", { name: "API key" });
  const raw = await field.inputValue();
  expect(raw).toMatch(/^apl_live_[A-Za-z0-9_-]{20,}$/);
  await expect(dialog(page)).toContainText("Ingest, Read · Can create apps · expires");
  // The environment to copy names the app with a placeholder and says the app appears on its own.
  await expect(dialog(page).locator("pre.ak-snippet")).toHaveText(new RegExp("APILENS_APP_ID=your-service-name$"));
  await expect(dialog(page)).toContainText("The app appears in Apps automatically when its first data arrives");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Copy API key" }).click();
  await expect(dialog(page).getByRole("status")).toHaveText("Copied to the clipboard.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(dialog(page)).toHaveCount(0);

  // Listed by prefix only, and never shown again.
  await expect(card(page).getByRole("status")).toHaveText("Created Production backend.");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByRole("cell").nth(1)).toHaveText(`${raw.slice(0, 16)}…`);
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest, Read · Can create apps");
  await expect(page.getByText(raw)).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Production backend");
  expect(await page.content()).not.toContain(raw);
});

test("cancelling the dialog creates nothing", async ({ page }) => {
  await signIn(page, { apiKeys: SEEDED.slice(0, 1) });
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await dialog(page).getByRole("textbox", { name: /Name/ }).fill("Throwaway");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await expect(dialog(page).getByRole("textbox", { name: /Name/ })).toHaveValue("");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(rows(page)).toHaveCount(1);
});

test("revokes a key after confirming", async ({ page }) => {
  await signIn(page, { apiKeys: SEEDED.slice(0, 2) });

  await rows(page).nth(1).getByRole("button", { name: "Revoke Analytics script" }).click();
  const confirm = card(page).getByRole("group", { name: /Revoke Analytics script\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  await rows(page).nth(1).getByRole("button", { name: "Revoke Analytics script" }).click();
  await confirm.getByRole("button", { name: "Revoke key" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Revoked Analytics script. Requests using it are rejected from now on.");
  await expect(rows(page).nth(1).getByRole("cell").nth(5)).toHaveText("Revoked");
  await expect(rows(page).nth(1).getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  await page.reload();
  await expect(rows(page).nth(1).getByRole("cell").nth(5)).toHaveText("Revoked");
  await expect(rows(page).nth(0).getByRole("cell").nth(5)).toContainText("Active");
});

test("without api_keys.create/revoke the list is read-only and says why", async ({ page }) => {
  await signIn(page, { capabilities: ["project.read"], apiKeys: SEEDED.slice(0, 1) });
  await expect(rows(page)).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Create API key" })).toHaveCount(0);
  await expect(rows(page).first().getByRole("button")).toHaveCount(0);
  await expect(card(page)).toContainText("You can see this project’s keys but not change them.");
});

test("limits a key to apps, which turns off creating apps, and back", async ({ page }) => {
  await signIn(page, { apiKeys: SEEDED.slice(0, 1) });
  await rows(page).first().getByRole("button", { name: "Edit access of Production backend" }).click();
  const create = dialog(page).getByRole("checkbox", { name: /Can create apps/ });
  await expect(create).toBeChecked();
  await dialog(page).getByRole("radio", { name: /Limit to apps/ }).check();
  await expect(create).toBeDisabled();
  await expect(dialog(page)).toContainText("Keys limited to apps never create apps");
  await dialog(page).getByRole("button", { name: "Save access" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Choose at least one app, or allow all apps.");
  await dialog(page).getByRole("checkbox", { name: /Shop/ }).check();
  await dialog(page).getByRole("button", { name: "Save access" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest · Limited to 1 app");
  await expect(rows(page).first().getByRole("cell").nth(3)).toContainText("Shop");

  await rows(page).first().getByRole("button", { name: "Edit access of Production backend" }).click();
  await dialog(page).getByRole("radio", { name: /All apps/ }).check();
  await expect(create).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Save access" }).click();
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest · Can create apps");
});

test("pages a long list in the URL", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `Key ${i + 1}`, scopes: ["read"], created_at: `2026-10-${String(30 - i).padStart(2, "0")}T10:00:00Z` }));
  await signIn(page, { apiKeys: many });
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("navigation", { name: "API key pages" }).getByRole("link", { name: "Page 2" }).click();
  await page.waitForURL(/page=2/);
  await expect(rows(page)).toHaveCount(5);
  // A page past the end lands on the last page.
  await page.goto(`${KEYS}?page=9`);
  await page.waitForURL(/page=2/);
  await expect(rows(page)).toHaveCount(5);
});

// Visual check (light/dark at 1440 and 390): `API_KEY_SHOTS=<dir> pnpm test:e2e:fake api-keys`.
test("screenshots", async ({ page }) => {
  const dir = process.env.API_KEY_SHOTS;
  test.skip(!dir, "set API_KEY_SHOTS to a directory to capture screenshots");
  for (const label of ["empty", "list", "create", "reveal"] as const) {
    await signIn(page, { apiKeys: label === "list" ? SEEDED : [] });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.reload();
        await expect(card(page)).toBeVisible();
        if (label === "list") await rows(page).nth(1).getByRole("button", { name: /^Revoke/ }).click();
        if (label === "create" || label === "reveal") {
          await card(page).getByRole("button", { name: "Create API key" }).click();
          await dialog(page).getByRole("textbox", { name: /Name/ }).fill("Production backend");
          await dialog(page).getByRole("combobox", { name: /Expires/ }).selectOption("custom");
        }
        if (label === "reveal") {
          await dialog(page).getByRole("combobox", { name: /Expires/ }).selectOption("365");
          await dialog(page).getByRole("button", { name: "Create key" }).click();
          await expect(dialog(page).getByRole("heading", { name: "Copy your new key" })).toBeVisible();
        }
        await page.screenshot({ path: `${dir}/api-keys-${label}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
