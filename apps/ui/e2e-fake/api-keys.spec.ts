// Access › API keys (#350, #801, #810) against the fake identity (e2e-fake/fake-identity.ts), which
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
const inactive = (page: Page) => card(page).getByRole("checkbox", { name: /Show inactive/ });
const stateFilter = (page: Page) => card(page).getByRole("combobox", { name: "State" });

const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();
/** `14 Nov`, as the State column names the end of a rotation. */
const dayMonth = (at: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(at));

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

/** One key in every state, newest first: active, rotating (in its overlap), expiring, expired, revoked. */
function stateKeys() {
  const ada = { id: "a1a1a1a1-0000-4000-8000-000000000001", name: "Ada Admin" };
  const successor = "9c0d1e2f-3a4b-4c5d-8e7f-8a9b0c1d2e3f";
  return [
    { id: successor, name: "Production backend", prefix: "apl_live_Hk27sQe", scopes: ["ingest"], created_at: iso(-26), created_by: ada, last_used_at: iso(-0.1), last_used_sdk: "apilenss/0.5.0", environments: ["production"] },
    { name: "Production backend", prefix: "apl_live_Q2x9aZ1", scopes: ["ingest"], created_at: "2026-09-01T10:00:00Z", last_used_at: iso(-3.2), last_used_sdk: "apilenss/0.4.2", expires_at: iso(22), rotated_to: successor, environments: ["production"] },
    { name: "Staging worker", prefix: "apl_live_r8Lm0Pq", scopes: ["ingest", "read"], can_create_apps: false, created_at: "2026-08-20T10:00:00Z", expires_at: iso(24 * 5 + 6), created_by: { id: "b2", name: "Priya Patel" } },
    { name: "Trial", prefix: "apl_live_t1Xb4Yc", scopes: ["ingest"], created_at: "2026-07-01T10:00:00Z", expires_at: "2026-07-31T00:00:00Z" },
    { name: "Old analytics export", prefix: "apl_live_k3Vn7Ws", scopes: ["read"], created_at: "2026-06-01T10:00:00Z", revoked_at: "2026-08-15T10:00:00Z" },
  ];
}

test("lists keys with what they can do, creator, last use, expiry and state; inactive keys are behind a toggle", async ({ page }) => {
  const seeded = stateKeys();
  await signIn(page, { apiKeys: seeded });
  await expect(card(page).getByRole("columnheader")).toHaveText(["Name", "Key", "Can", "Created", "Last used", "Expires", "State", "Actions"]);

  // Expired and revoked keys are hidden until "Show inactive" is on.
  await expect(inactive(page)).not.toBeChecked();
  await expect(inactive(page)).toHaveAccessibleName("Show inactive (2)");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).getByRole("cell")).toHaveText([
    "Production backend",
    "apl_live_Hk27sQe…",
    "Ingest and create appsAll apps · Only production",
    /by Ada Admin$/,
    "6 minutes agoapilenss 0.5.0",
    "Never",
    "Active",
    "Edit accessRotateRevoke",
  ]);
  // Last use: relative time, the SDK and version, the exact time on hover.
  await expect(rows(page).nth(0).locator("td[data-label='Last used'] time")).toHaveAttribute("title", /UTC$/);
  await expect(rows(page).nth(1).getByRole("cell").nth(6)).toHaveText(`Rotating until ${dayMonth(seeded[1].expires_at as string)}`);
  await expect(rows(page).nth(1).getByRole("cell").nth(4)).toHaveText("3 hours agoapilenss 0.4.2");
  await expect(rows(page).nth(2).getByRole("cell").nth(2)).toHaveText("Ingest and readAll apps · All environments");
  await expect(rows(page).nth(2).getByRole("cell").nth(3)).toHaveText("Aug 20, 2026by Priya Patel");
  await expect(rows(page).nth(2).getByRole("cell").nth(4)).toHaveText("Never");
  await expect(rows(page).nth(2).getByRole("cell").nth(6)).toHaveText("Expires in 5 days");

  await inactive(page).check();
  await page.waitForURL((url) => url.searchParams.get("inactive") === "1");
  await expect(rows(page)).toHaveCount(5);
  await expect(rows(page).nth(3).getByRole("cell").nth(5)).toHaveText("Jul 31, 2026");
  await expect(rows(page).nth(3).getByRole("cell").nth(6)).toHaveText("Expired");
  await expect(rows(page).nth(3).getByRole("button", { name: "Revoke Trial" })).toBeEnabled();
  // A revoked key cannot be revoked again.
  await expect(rows(page).nth(4).getByRole("cell")).toHaveText(["Old analytics export", "apl_live_k3Vn7Ws…", "Read", "Jun 1, 2026", "Never", "Never", "Revoked", ""]);

  // Filter by state, in the URL.
  await stateFilter(page).selectOption("rotating");
  await page.waitForURL((url) => url.searchParams.get("state") === "rotating");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("apl_live_Q2x9aZ1…");
  await stateFilter(page).selectOption("revoked");
  await page.waitForURL((url) => url.searchParams.get("state") === "revoked");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Old analytics export");
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(stateFilter(page)).toHaveValue("revoked");

  // Hiding inactive keys drops a filter that only matches them.
  await inactive(page).uncheck();
  await page.waitForURL((url) => !url.searchParams.has("state") && !url.searchParams.has("inactive"));
  await expect(rows(page)).toHaveCount(3);
  await expect(stateFilter(page).locator("option")).toHaveText(["All states", "Active", "Expiring soon", "Rotating"]);
  await stateFilter(page).selectOption("expiring");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Staging worker");
});

test("creates a key and shows it once with copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);

  // The empty state points to SDK setup.
  await expect(card(page).getByRole("heading", { name: "No API keys yet" })).toBeVisible();
  await expect(card(page).getByRole("link", { name: "Set up the SDK" })).toHaveAttribute("href", "/shop/settings/sdk");
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

  // Listed by prefix only, and never shown again: not on the page, in the DOM or after a reload.
  await expect(card(page).getByRole("status")).toHaveText("Created Production backend.");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByRole("cell").nth(1)).toHaveText(`${raw.slice(0, 16)}…`);
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest, create apps and readAll apps · All environments");
  await expect(rows(page).first().getByRole("cell").nth(6)).toHaveText("Active");
  await expect(page.getByText(raw)).toHaveCount(0);
  expect(await page.content()).not.toContain(raw);
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

test("revokes a key after typing its name in the shared dialog", async ({ page }) => {
  await signIn(page, { apiKeys: SEEDED.slice(0, 2) });

  const opener = rows(page).nth(1).getByRole("button", { name: "Revoke Analytics script" });
  await opener.click();
  const confirm = page.getByRole("dialog", { name: "Revoke Analytics script?" });
  await expect(confirm).toContainText("apl_live_r8Lm0Pq…");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Escape cancels and focus goes back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  const typed = confirm.getByRole("textbox", { name: /To confirm, type/ });
  const action = confirm.getByRole("button", { name: "Revoke key" });
  await expect(action).toBeDisabled();
  await typed.fill("analytics script");
  await expect(action).toBeDisabled();
  await typed.fill("Analytics script");
  await action.click();
  await expect(confirm).toHaveCount(0);
  await expect(card(page).getByRole("status")).toHaveText("Revoked Analytics script. Requests using it are rejected from now on.");
  // Revoked keys are inactive: hidden until "Show inactive" is on.
  await expect(rows(page)).toHaveCount(1);
  await expect(inactive(page)).toHaveAccessibleName("Show inactive (1)");
  await page.reload();
  await inactive(page).check();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1).getByRole("cell").nth(6)).toHaveText("Revoked");
  await expect(rows(page).nth(1).getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  await expect(rows(page).nth(0).getByRole("cell").nth(6)).toHaveText("Active");
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
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("IngestOnly Shop · All environments");

  await rows(page).first().getByRole("button", { name: "Edit access of Production backend" }).click();
  await dialog(page).getByRole("radio", { name: /All apps/ }).check();
  await expect(create).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Save access" }).click();
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest and create appsAll apps · All environments");
});

// Rotation (#811): each overlap, then the new key is revealed once and never again.
for (const overlap of [
  { label: "Stop now", hint: "The old key stops working as soon as you rotate." },
  { label: "24 hours", hint: /^The old key keeps working until .+ UTC\.$/ },
  { label: "7 days", hint: /^The old key keeps working until .+ UTC\.$/ },
]) {
  test(`rotates a key with "${overlap.label}"; the new key is shown once and gone after reload`, async ({ page }) => {
    await signIn(page, { apiKeys: SEEDED.slice(0, 1) });
    const opener = rows(page).first().getByRole("button", { name: "Rotate Production backend" });
    await opener.click();
    const rotate = page.getByRole("dialog", { name: "Rotate Production backend?" });
    await expect(rotate).toContainText("A new key with the same access replaces apl_live_Q2x9aZ1…");
    await expect(rotate.getByRole("button", { name: "Cancel" })).toBeFocused();
    // 24 hours is the default; Escape cancels and focus goes back to Rotate.
    await expect(rotate.getByRole("radio", { name: /24 hours/ })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(rotate).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(rows(page)).toHaveCount(1);

    await opener.click();
    await rotate.getByRole("radio", { name: new RegExp(overlap.label) }).check();
    await expect(rotate.getByRole("group", { name: "How long the old key keeps working" })).toHaveAccessibleDescription(overlap.hint);
    await rotate.getByRole("button", { name: "Rotate key" }).click();

    // The reveal: Escape does not dismiss it and Done waits for "I have stored this key".
    await expect(dialog(page).getByRole("heading", { name: "Copy your new key" })).toBeVisible();
    const raw = await dialog(page).getByRole("textbox", { name: "API key" }).inputValue();
    expect(raw).toMatch(/^apl_live_[A-Za-z0-9_-]{20,}$/);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    const done = dialog(page).getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await dialog(page).getByRole("checkbox", { name: /I have stored this key/ }).check();
    await done.click();
    await expect(dialog(page)).toHaveCount(0);

    const fresh = rows(page).first();
    await expect(fresh.getByRole("cell").nth(1)).toHaveText(`${raw.slice(0, 16)}…`);
    await expect(fresh.getByRole("cell").nth(6)).toHaveText("Active");
    if (overlap.label === "Stop now") {
      await expect(card(page).getByRole("status")).toHaveText("Rotated Production backend. The old key no longer works.");
      // The old key expired at once: it is inactive, behind the toggle.
      await expect(rows(page)).toHaveCount(1);
      await expect(inactive(page)).toHaveAccessibleName("Show inactive (1)");
    } else {
      await expect(card(page).getByRole("status")).toHaveText(/^Rotated Production backend\. The old key works until .+ UTC\.$/);
      await expect(rows(page)).toHaveCount(2);
      const days = overlap.label === "7 days" ? 7 : 1;
      await expect(rows(page).nth(1).getByRole("cell").nth(6)).toHaveText(`Rotating until ${dayMonth(iso(days * 24))}`);
      // A key in its overlap is not rotated again.
      await expect(rows(page).nth(1).getByRole("button", { name: "Rotate Production backend" })).toHaveCount(0);
    }

    // Never shown again: not on the page, in the DOM or after a reload.
    expect(await page.content()).not.toContain(raw);
    await page.reload();
    await expect(rows(page)).toHaveCount(overlap.label === "Stop now" ? 1 : 2);
    await expect(rows(page).first().getByRole("cell").nth(1)).toHaveText(`${raw.slice(0, 16)}…`);
    expect(await page.content()).not.toContain(raw);
  });
}

test("creates a key with an expiry date and limited to environments", async ({ page }) => {
  // Shop's measured environments: production, staging, canary, preview and a hidden qa-legacy.
  await fetch(`${IDENTITY}/__fake/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await signIn(page);
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await dialog(page).getByRole("textbox", { name: /Name/ }).fill("Staging worker");
  await dialog(page).getByRole("combobox", { name: /Expires/ }).selectOption("custom");
  await dialog(page).getByLabel("Expiry date").fill("2099-01-15");

  const envs = dialog(page).getByRole("group", { name: "Environments it may send data for" });
  await expect(envs.getByRole("radio", { name: /All environments/ })).toBeChecked();
  await envs.getByRole("radio", { name: /Limit to environments/ }).check();
  const picks = envs.getByRole("list", { name: "Environments this key may send data for" });
  // Hidden environments are not offered.
  await expect(picks.getByRole("checkbox")).toHaveCount(4);
  await expect(picks.getByRole("checkbox", { name: "qa-legacy" })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Choose at least one environment, or allow all environments.");
  await picks.getByRole("checkbox", { name: "staging" }).check();
  await picks.getByRole("checkbox", { name: "production" }).check();
  await dialog(page).getByRole("button", { name: "Create key" }).click();

  await expect(dialog(page).getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(dialog(page)).toContainText("expires Jan 15, 2099");
  // Creating needs no acknowledgement; Done closes it.
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest and create appsAll apps · Only production and staging");
  await expect(rows(page).first().getByRole("cell").nth(5)).toHaveText("Jan 15, 2099");
  await page.reload();
  await expect(rows(page).first().getByRole("cell").nth(2)).toHaveText("Ingest and create appsAll apps · Only production and staging");
});

test("a read-only key never shows the environment field", async ({ page }) => {
  await fetch(`${IDENTITY}/__fake/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await signIn(page);
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await expect(dialog(page).getByRole("group", { name: "Environments it may send data for" })).toBeVisible();
  await dialog(page).getByRole("checkbox", { name: /Ingest/ }).uncheck();
  await dialog(page).getByRole("checkbox", { name: /Read/ }).check();
  await expect(dialog(page).getByRole("group", { name: "Environments it may send data for" })).toHaveCount(0);
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
  for (const label of ["empty", "list", "revoke", "reveal", "rotate"] as const) {
    await signIn(page, { apiKeys: label === "empty" || label === "reveal" ? [] : stateKeys() });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.goto(label === "list" ? `${KEYS}?inactive=1` : KEYS);
        await expect(card(page)).toBeVisible();
        if (label === "revoke") {
          await rows(page).nth(2).getByRole("button", { name: /^Revoke/ }).click();
          await page.getByRole("dialog").getByRole("textbox").fill("Staging worker");
        }
        if (label === "rotate") {
          await rows(page).nth(0).getByRole("button", { name: /^Rotate/ }).click();
          await expect(page.getByRole("dialog", { name: /^Rotate/ })).toBeVisible();
        }
        if (label === "reveal") {
          await card(page).getByRole("button", { name: "Create API key" }).click();
          await dialog(page).getByRole("textbox", { name: /Name/ }).fill("Production backend");
          await dialog(page).getByRole("combobox", { name: /Expires/ }).selectOption("365");
          await dialog(page).getByRole("button", { name: "Create key" }).click();
          await expect(dialog(page).getByRole("heading", { name: "Copy your new key" })).toBeVisible();
        }
        await page.screenshot({ path: `${dir}/api-keys-${label}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
