// Security → Passkeys (#341) against the fake identity (e2e-fake/fake-identity.ts), with Chrome's
// CDP virtual authenticator standing in for Touch ID / a security key. "Add a passkey" goes
// through the real Route Handlers (`/api/auth/passkeys/register/*`) to the fake, which checks
// the browser's clientDataJSON (type, challenge, origin). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SECURITY = "/settings/security";

async function signIn(page: Page, passkeys: Record<string, unknown>[] = []) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: SECURITY, passkeys }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === SECURITY);
}

/** A platform authenticator that says yes to every ceremony (user verified, no UI). */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

const card = (page: Page) => page.getByRole("region", { name: "Passkeys" });
const rows = (page: Page) => card(page).locator("tbody tr.pk-row");

test("adds a passkey from the empty state and names it", async ({ page }) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await signIn(page);

  await expect(card(page).getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Add a passkey" })).toHaveCount(1);
  await card(page).getByRole("button", { name: "Add a passkey" }).click();

  // Registered: the new row opens its name for editing, with identity's default selected.
  const name = card(page).getByRole("textbox", { name: "Passkey name" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Chrome");
  await expect(card(page).getByRole("status")).toHaveText("Passkey added. Give it a name you’ll recognise.");
  await name.fill("Work laptop");
  await name.press("Enter");

  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Work laptop");
  await expect(rows(page).first()).toContainText("This device’s authenticator");
  await expect(rows(page).first()).toContainText("Never");
  await expect(card(page).getByRole("status")).toHaveText("Name saved.");

  // The authenticator really holds a discoverable credential now.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].isResidentCredential).toBe(true);

  // Kept by identity, not just by the page.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Work laptop");

  // The same authenticator cannot hold a second passkey for the account (excludeCredentials).
  await card(page).getByRole("button", { name: "Add a passkey" }).click();
  await expect(card(page).getByRole("status")).toHaveText("This authenticator already holds a passkey for your account.");
  await expect(rows(page)).toHaveCount(1);
});

test("lists passkeys with their authenticator, dates and synced badge", async ({ page }) => {
  await signIn(page, [
    { name: "iPhone", authenticator: "iCloud Keychain", backup_state: true, created_at: "2026-09-01T10:00:00Z", last_used_at: "2026-09-02T10:00:00Z" },
    { name: "YubiKey", transports: ["usb", "nfc"], created_at: "2026-10-01T10:00:00Z" },
  ]);
  await expect(card(page).getByRole("columnheader")).toHaveText(["Name", "Authenticator", "Added", "Last used", "Actions"]);
  await expect(rows(page)).toHaveCount(2);
  const [iphone, key] = [rows(page).nth(0), rows(page).nth(1)];
  await expect(iphone.getByRole("cell")).toHaveText(["iPhoneSynced", "iCloud Keychain", "Sep 1, 2026", "Sep 2, 2026", "RenameRemove"]);
  await expect(key.getByRole("cell")).toHaveText(["YubiKey", "Security key", "Oct 1, 2026", "Never", "RenameRemove"]);
  await expect(key.getByText("Synced")).toHaveCount(0);
});

test("renames inline: Escape cancels, Enter saves, blank names are refused", async ({ page }) => {
  await signIn(page, [{ name: "iPhone" }]);
  const row = rows(page).first();

  await row.getByRole("button", { name: "Rename iPhone" }).click();
  const name = card(page).getByRole("textbox", { name: "Passkey name" });
  await expect(name).toBeFocused();
  await name.fill("Something else");
  await name.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(row).toContainText("iPhone");
  await expect(row.getByRole("button", { name: "Rename iPhone" })).toBeFocused();

  await page.keyboard.press("Enter");
  await name.fill("   ");
  await name.press("Enter");
  await expect(card(page).getByRole("alert")).toHaveText("Enter a name.");
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("Personal phone");
  await card(page).getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Personal phone");
  await page.reload();
  await expect(rows(page).first()).toContainText("Personal phone");
});

test("removes a passkey after confirming", async ({ page }) => {
  await signIn(page, [{ name: "iPhone" }, { name: "YubiKey", transports: ["usb"] }]);

  await rows(page).nth(1).getByRole("button", { name: "Remove YubiKey" }).click();
  const confirm = card(page).getByRole("group", { name: /Remove YubiKey\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);

  await rows(page).nth(1).getByRole("button", { name: "Remove YubiKey" }).click();
  await confirm.getByRole("button", { name: "Remove passkey" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(card(page).getByRole("status")).toHaveText("Removed YubiKey.");

  await rows(page).first().getByRole("button", { name: "Remove iPhone" }).click();
  await card(page).getByRole("button", { name: "Remove passkey" }).click();
  await expect(card(page).getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
  await page.reload();
  await expect(card(page).getByRole("heading", { name: "No passkeys yet" })).toBeVisible();
});

// Visual check (light/dark at 1440 and 390): `PASSKEY_SHOTS=<dir> pnpm test:e2e:fake passkeys`.
test("screenshots", async ({ page }) => {
  const dir = process.env.PASSKEY_SHOTS;
  test.skip(!dir, "set PASSKEY_SHOTS to a directory to capture screenshots");
  for (const [label, seeds] of [
    ["empty", []],
    [
      "list",
      [
        { name: "iPhone", authenticator: "iCloud Keychain", backup_state: true, created_at: "2026-09-01T10:00:00Z", last_used_at: "2026-11-03T10:00:00Z" },
        { name: "YubiKey 5C", authenticator: "YubiKey 5 Series", transports: ["usb", "nfc"], created_at: "2026-10-01T10:00:00Z" },
        { name: "Work laptop", transports: ["internal"], created_at: "2026-10-20T10:00:00Z", last_used_at: "2026-10-29T10:00:00Z" },
      ],
    ],
  ] as const) {
    await signIn(page, [...seeds]);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.reload();
        await expect(card(page)).toBeVisible();
        // The list with one removal being confirmed.
        if (label === "list") await rows(page).nth(1).getByRole("button", { name: /^Remove/ }).click();
        await page.screenshot({ path: `${dir}/passkeys-${label}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
