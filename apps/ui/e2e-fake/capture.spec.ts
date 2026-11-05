// Project settings → Capture (#598) against the fake identity (e2e-fake/fake-identity.ts), which
// serves shop's apps (`GET /project`), their capture policies (`GET|PUT /apps/{id}/capture-policy`,
// 403 on PUT without `capture.manage`) and what their SDKs reported (`GET /apps/{id}/metadata`).
// No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const CAPTURE = "/shop/settings/capture";
const ADMIN = ["project.read", "project.update", "capture.manage"];
const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const WORKER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async function seedApps(apps: Record<string, unknown>[] = []) {
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
}

async function signIn(page: Page, capabilities: string[] = ADMIN, next = CAPTURE) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === CAPTURE);
}

const policy = (page: Page) => page.locator("form").filter({ has: page.getByRole("heading", { name: "Capture", exact: true }) });
const sdk = (page: Page) => page.getByRole("region", { name: "What the SDKs run with" });
const toggle = (page: Page, name: string) => policy(page).getByRole("switch", { name });
const rate = (page: Page) => policy(page).getByRole("textbox", { name: /Sample rate/ });
const cap = (page: Page) => policy(page).getByRole("textbox", { name: /Body size cap/ });
const save = (page: Page) => policy(page).getByRole("button", { name: "Save" });
const status = (page: Page) => policy(page).getByRole("status");

test.beforeEach(async () => {
  await seedApps();
});

test("an admin edits the policy and sees it apply within 60 s", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Capture policy" })).toBeVisible();
  await expect(policy(page)).toContainText("Saved changes apply within 60 s, on the SDKs’ next heartbeat.");
  await expect(policy(page)).toContainText("Never changed: the app captures everything.");
  await expect(toggle(page, "Capture requests")).toHaveAttribute("aria-checked", "true");
  await expect(rate(page)).toHaveValue("100");
  await expect(cap(page)).toHaveValue("");
  await expect(save(page)).toBeDisabled();

  // Checked in the browser before anything is sent.
  await rate(page).fill("150");
  await save(page).click();
  await expect(policy(page).getByText("Enter a percentage from 0 to 100, with at most 2 decimals.")).toBeVisible();
  await rate(page).fill("12.5");
  await cap(page).fill("0");
  await save(page).click();
  await expect(policy(page).getByText(/Enter a size from 1 to 1,048,576 bytes/)).toBeVisible();

  await cap(page).fill("4096");
  await toggle(page, "Headers").click();
  await toggle(page, "Request bodies").click();
  await save(page).click();
  await expect(status(page)).toHaveText("Saved. Shop’s SDKs apply it within 60 s.");
  await expect(policy(page)).toContainText(/Last changed .* by you\. Every change is recorded in the audit log\./);
  await expect(save(page)).toBeDisabled();

  await page.reload();
  await expect(rate(page)).toHaveValue("12.5");
  await expect(cap(page)).toHaveValue("4096");
  await expect(toggle(page, "Headers")).toHaveAttribute("aria-checked", "false");
  await expect(toggle(page, "Request bodies")).toHaveAttribute("aria-checked", "false");
  await expect(toggle(page, "Response bodies")).toHaveAttribute("aria-checked", "true");
});

test("turning capture off asks first", async ({ page }) => {
  await signIn(page);
  await toggle(page, "Capture requests").click();
  await expect(policy(page)).toContainText("Off: the SDKs send nothing for this app until capture is turned back on.");
  await save(page).click();

  const confirm = policy(page).getByRole("group", { name: /Stop capturing Shop\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(status(page)).toHaveText("");

  await save(page).click();
  await confirm.getByRole("button", { name: "Stop capturing" }).click();
  await expect(status(page)).toHaveText("Saved. Shop’s SDKs stop capturing within 60 s.");
  await page.reload();
  await expect(toggle(page, "Capture requests")).toHaveAttribute("aria-checked", "false");

  // Turning it back on needs no confirmation.
  await toggle(page, "Capture requests").click();
  await save(page).click();
  await expect(status(page)).toHaveText("Saved. Shop’s SDKs apply it within 60 s.");
});

test("a viewer sees the policy read-only", async ({ page }) => {
  await seedApps([{ id: SHOP, slug: "shop", name: "Shop", policy: { sample_rate: 0.25, capture_headers: false, max_payload_bytes: 8192, updated_at: "2026-11-01T10:00:00Z", updated_by: "someone-else" } }]);
  await signIn(page, ["project.read"]);
  await expect(page.getByText("You can see this policy. Only project admins can change it.")).toBeVisible();
  await expect(rate(page)).toHaveValue("25");
  await expect(rate(page)).toBeDisabled();
  await expect(cap(page)).toHaveValue("8192");
  await expect(cap(page)).toBeDisabled();
  for (const name of ["Capture requests", "Headers", "Request bodies", "Response bodies"]) await expect(toggle(page, name)).toBeDisabled();
  await expect(toggle(page, "Headers")).toHaveAttribute("aria-checked", "false");
  await expect(save(page)).toHaveCount(0);
  await expect(policy(page)).toContainText("by a project admin");
});

test("shows what each environment's SDK runs with and the narrower setting that applies", async ({ page }) => {
  await seedApps([
    {
      id: SHOP,
      slug: "shop",
      name: "Shop",
      policy: { sample_rate: 0.5, max_payload_bytes: 8192 },
      environments: [
        {
          environment: "production",
          framework: "fastapi",
          framework_version: "0.115.0",
          runtime_version: "Python 3.12.4",
          sdk_version: "0.6.0",
          config: { sample_rate: 0.25, capture_headers: false, capture_request_body: true, max_payload_bytes: 65536 },
          received_at: "2026-11-04T09:30:00Z",
        },
      ],
    },
  ]);
  await signIn(page);
  await expect(sdk(page)).toContainText("fastapi 0.115.0 · Python 3.12.4 · SDK 0.6.0 · reported");
  const table = sdk(page).getByRole("table", { name: "production" });
  await expect(table.getByRole("columnheader")).toHaveText(["Setting", "This policy", "SDK config", "Applies"]);
  const row = (name: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(row("Sample rate").getByRole("cell")).toHaveText(["50%", "25%", "25%set by the SDK"]);
  await expect(row("Headers").getByRole("cell")).toHaveText(["On", "Off", "Offset by the SDK"]);
  await expect(row("Request bodies").getByRole("cell")).toHaveText(["On", "On", "On"]);
  await expect(row("Response bodies").getByRole("cell")).toHaveText(["On", "Not reported", "On"]);
  await expect(row("Body size cap").getByRole("cell")).toHaveText(["8,192 bytes (8 KiB)", "65,536 bytes (64 KiB)", "8,192 bytes (8 KiB)"]);

  // Saving the policy updates what applies.
  await rate(page).fill("10");
  await save(page).click();
  await expect(status(page)).toHaveText("Saved. Shop’s SDKs apply it within 60 s.");
  await expect(row("Sample rate").getByRole("cell")).toHaveText(["10%", "25%", "10%"]);
});

test("without SDK reports the page says so", async ({ page }) => {
  await signIn(page);
  await expect(sdk(page)).toContainText("No SDK has reported its config yet. SDKs report it once each time the app starts.");
});

test("each app has its own policy", async ({ page }) => {
  await seedApps([
    { id: SHOP, slug: "shop", name: "Shop" },
    { id: WORKER, slug: "worker", name: "Worker", policy: { enabled: false } },
  ]);
  await signIn(page);
  const picker = page.getByRole("combobox", { name: /App/ });
  await expect(picker).toHaveValue("shop");
  await expect(toggle(page, "Capture requests")).toHaveAttribute("aria-checked", "true");
  await picker.selectOption("worker");
  await page.waitForURL((url) => url.searchParams.get("app") === "worker");
  await expect(toggle(page, "Capture requests")).toHaveAttribute("aria-checked", "false");
  await expect(policy(page)).toContainText("What Worker’s SDKs send.");
});

// Visual check (light/dark at 1440 and 390): `CAPTURE_SHOTS=<dir> pnpm test:e2e:fake capture`.
test("screenshots", async ({ page }) => {
  const dir = process.env.CAPTURE_SHOTS;
  test.skip(!dir, "set CAPTURE_SHOTS to a directory to capture screenshots");
  await seedApps([
    {
      id: SHOP,
      slug: "shop",
      name: "Shop",
      policy: { sample_rate: 0.5, max_payload_bytes: 8192 },
      environments: [
        { environment: "production", framework: "fastapi", framework_version: "0.115.0", runtime_version: "Python 3.12.4", sdk_version: "0.6.0", config: { sample_rate: 0.25, capture_headers: false }, received_at: "2026-11-04T09:30:00Z" },
        { environment: "staging", framework: "fastapi", framework_version: "0.115.0", runtime_version: "Python 3.12.4", sdk_version: "0.6.0", config: {}, received_at: "2026-11-04T08:10:00Z" },
      ],
    },
    { id: WORKER, slug: "worker", name: "Worker" },
  ]);
  for (const caps of [ADMIN, ["project.read"]]) {
    await signIn(page, caps);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.reload();
        await expect(policy(page)).toBeVisible();
        if (caps === ADMIN) {
          await toggle(page, "Capture requests").click();
          await save(page).click();
        }
        await page.screenshot({ path: `${dir}/capture-${caps === ADMIN ? "admin" : "viewer"}-${theme}-${width}.png`, fullPage: true });
        await sdk(page).screenshot({ path: `${dir}/capture-sdk-${caps === ADMIN ? "admin" : "viewer"}-${theme}-${width}.png` });
      }
    }
  }
});
