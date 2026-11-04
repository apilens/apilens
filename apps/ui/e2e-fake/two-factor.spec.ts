// The two-factor step (#320) end to end against the fake identity (e2e-fake/fake-identity.ts).
// Each test generates its own TOTP secret, asks the fake for a handoff code whose sign-in answers
// `2fa_required`, and lets `/auth/callback` park the pre-auth token in its httpOnly cookie and
// send the browser to `/auth/2fa`. Codes are computed here with RFC 6238, like an authenticator app.
import { createHmac, randomBytes } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const SESSION_COOKIE = "apilens_session";
const PRE_AUTH_COOKIE = "apilens_preauth";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh 160-bit TOTP secret, base32 encoded as an authenticator app would scan it. */
function newSecret(): { base32: string; key: Buffer } {
  const key = randomBytes(20);
  let bits = 0;
  let value = 0;
  let base32 = "";
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      base32 += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) base32 += BASE32[(value << (5 - bits)) & 31];
  return { base32, key };
}

/** RFC 6238: HMAC-SHA1, 30-second steps, 6 digits. */
function totp(key: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A 6-digit code that is valid in no window near now. */
function wrongCode(key: Buffer): string {
  const valid = new Set([-30_000, 0, 30_000].map((d) => totp(key, Date.now() + d)));
  for (let n = 0; ; n++) {
    const c = String(n).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
}

async function cookie(page: Page, name: string) {
  return (await page.context().cookies()).find((c) => c.name === name);
}

/** Signs in through the fake OAuth handoff to the two-factor step; answers the secret's key. */
async function toTwoFactor(page: Page, next: string, backupCodes: string[] = []): Promise<Buffer> {
  const secret = newSecret();
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, totp_secret: secret.base32, backup_codes: backupCodes }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/auth/2fa");
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  expect(await cookie(page, SESSION_COOKIE)).toBeUndefined();
  return secret.key;
}

const codeInput = (page: Page) => page.getByLabel("6-digit code");
const backupInput = (page: Page) => page.getByLabel("Backup code");
const problem = (page: Page) => page.locator("#tf-problem");

test("signs in with the authenticator code after a wrong one", async ({ page }) => {
  const key = await toTwoFactor(page, "/acme/requests");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/acme/requests");
  // The pre-auth token is httpOnly and only sent to the exchange route.
  const pre = await cookie(page, PRE_AUTH_COOKIE);
  expect(pre?.httpOnly).toBe(true);
  expect(pre?.path).toBe("/api/auth/2fa");

  await expect(codeInput(page)).toHaveAttribute("autocomplete", "one-time-code");
  await codeInput(page).fill(wrongCode(key));
  await expect(problem(page)).toHaveText("Wrong code. 4 attempts left.");
  await expect(codeInput(page)).toHaveValue("");

  await codeInput(page).fill(totp(key));
  await page.waitForURL((url) => url.pathname === "/acme/requests");
  expect((await cookie(page, SESSION_COOKIE))?.httpOnly).toBe(true);
  expect(await cookie(page, PRE_AUTH_COOKIE)).toBeUndefined();
});

test("signs in with a backup code after a wrong one", async ({ page }) => {
  await toTwoFactor(page, "/acme/endpoints", ["abcd-2345"]);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await expect(backupInput(page)).toBeFocused();
  const verify = page.getByRole("button", { name: "Verify" });
  await expect(verify).toBeDisabled();

  await backupInput(page).fill("WXYZ7777");
  await expect(backupInput(page)).toHaveValue("wxyz-7777");
  await backupInput(page).press("Enter");
  await expect(problem(page)).toHaveText("That backup code didn’t work. 4 attempts left.");

  await backupInput(page).fill("ABCD 2345");
  await expect(backupInput(page)).toHaveValue("abcd-2345");
  await verify.click();
  await page.waitForURL((url) => url.pathname === "/acme/endpoints");
  expect(await cookie(page, SESSION_COOKIE)).toBeTruthy();
});

test("switches back to the authenticator code", async ({ page }) => {
  const key = await toTwoFactor(page, "/acme/requests");
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByRole("button", { name: "Use your authenticator app" }).click();
  await expect(codeInput(page)).toBeFocused();
  await codeInput(page).fill(totp(key));
  await page.waitForURL((url) => url.pathname === "/acme/requests");
});

test("the fifth wrong code goes back to sign-in with a notice, keeping next", async ({ page }) => {
  const key = await toTwoFactor(page, "/acme/requests");
  const bad = wrongCode(key);
  for (let left = 4; left >= 1; left--) {
    await codeInput(page).fill(bad);
    await expect(problem(page)).toHaveText(`Wrong code. ${left} ${left === 1 ? "attempt" : "attempts"} left.`);
  }
  await codeInput(page).fill(bad);
  await page.waitForURL(
    (url) =>
      url.pathname === "/sign-in" &&
      url.searchParams.get("reason") === "2fa_locked" &&
      url.searchParams.get("next") === "/acme/requests",
  );
  await expect(page.getByText("Too many wrong two-factor codes.", { exact: false })).toBeVisible();
  expect(await cookie(page, SESSION_COOKIE)).toBeUndefined();
});

test("without a pending sign-in the step goes back to sign-in", async ({ page }) => {
  await page.goto("/auth/2fa");
  await codeInput(page).fill("123456");
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("reason") === "2fa_expired");
  await expect(page.getByText("Your two-factor step timed out.", { exact: false })).toBeVisible();
});

test("'Lost your device?' opens account recovery", async ({ page }) => {
  await toTwoFactor(page, "/");
  await page.getByRole("link", { name: "Lost your device?" }).click();
  await page.waitForURL((url) => url.pathname === "/auth/recovery");
  await expect(page.getByRole("heading", { name: "Lost your device?" })).toBeVisible();
});
