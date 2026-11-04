// Security → Two-factor (#342) against the fake identity (e2e-fake/fake-identity.ts): turning it on
// with the QR code's secret, the backup codes shown once (download, "I saved them"), regenerating
// them, and turning it off with a code or a backup code. Codes come from otplib, like an
// authenticator app would compute them from the secret the dialog shows.
import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";
import { generateSync } from "otplib";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const SECURITY = "/settings/security";

async function signIn(page: Page, opts: { stale?: boolean } = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: SECURITY, stale: opts.stale ?? false }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === SECURITY);
}

const totp = (secret: string) => generateSync({ secret });

/** A 6-digit code that is valid in no window near now. */
function wrongCode(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const valid = new Set([-30, 0, 30].map((d) => generateSync({ secret, epoch: now + d })));
  for (let n = 0; ; n++) {
    const c = String(n).padStart(6, "0");
    if (!valid.has(c)) return c;
  }
}

const dialog = (page: Page) => page.getByRole("dialog");
const state = (page: Page) => page.getByTestId("tf-state");
const codeInput = (page: Page) => dialog(page).getByLabel("6-digit code");

async function readCodes(page: Page): Promise<string[]> {
  return dialog(page).getByRole("list", { name: "Backup codes" }).getByRole("listitem").allTextContents();
}

/** Acknowledges the backup codes step and closes it. */
async function finishCodes(page: Page) {
  const done = dialog(page).getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await dialog(page).getByLabel("I saved my backup codes somewhere safe").check();
  await done.click();
  await expect(dialog(page)).toBeHidden();
}

/** Turns two-factor on through the dialog; answers the secret and the backup codes. */
async function enable(page: Page): Promise<{ secret: string; codes: string[] }> {
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Turn on two-factor authentication" })).toBeVisible();
  const secret = (await dialog(page).getByTestId("tf-secret").textContent())?.replace(/\s/g, "") ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await codeInput(page).fill(totp(secret));
  await expect(dialog(page).getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
  const codes = await readCodes(page);
  await finishCodes(page);
  return { secret, codes };
}

test("turns two-factor on with the QR secret and shows the backup codes once", async ({ page }) => {
  await signIn(page);
  await expect(state(page)).toHaveText("Off");

  await page.getByRole("button", { name: "Turn on" }).click();
  const d = dialog(page);
  await expect(d.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = (await d.getByTestId("tf-secret").textContent())?.replace(/\s/g, "") ?? "";
  await expect(codeInput(page)).toBeFocused();

  await codeInput(page).fill(wrongCode(secret));
  await expect(d.getByRole("alert")).toHaveText("Wrong code. Enter the current code from your authenticator app.");
  await expect(codeInput(page)).toHaveValue("");

  await codeInput(page).fill(totp(secret));
  await expect(d.getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
  const codes = await readCodes(page);
  expect(codes).toHaveLength(10);
  for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);

  // The codes cannot be dismissed unseen: no close button, Escape does nothing.
  await expect(d.getByRole("button", { name: "Close" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(d).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download .txt" }).click()]);
  expect(download.suggestedFilename()).toBe("apilens-backup-codes.txt");
  const text = await readFile(await download.path(), "utf8");
  for (const c of codes) expect(text).toContain(c);
  expect(text).toContain("Account: you@example.com");

  await finishCodes(page);
  await expect(state(page)).toHaveText("On");
  await expect(page.getByTestId("tf-remaining")).toHaveText("10 backup codes left.");
  await expect(page.getByRole("status").filter({ hasText: "Two-factor authentication is on." })).toBeVisible();

  // Identity keeps it: a reload reads the same status, and the codes are not shown again.
  await page.reload();
  await expect(state(page)).toHaveText("On");
  await expect(page.getByText(codes[0])).toHaveCount(0);
});

test("cancelling the enable dialog leaves two-factor off", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(codeInput(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(state(page)).toHaveText("Off");
});

test("regenerates backup codes; the old ones stop working", async ({ page }) => {
  await signIn(page);
  const { secret, codes: old } = await enable(page);

  await page.getByRole("button", { name: "Regenerate backup codes" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Regenerate backup codes" })).toBeVisible();
  await codeInput(page).fill(wrongCode(secret));
  await expect(dialog(page).getByRole("alert")).toContainText("Wrong code.");
  await codeInput(page).fill(totp(secret));
  await expect(dialog(page).getByRole("heading", { name: "Save your new backup codes" })).toBeVisible();
  const fresh = await readCodes(page);
  expect(fresh).toHaveLength(10);
  expect(fresh.filter((c) => old.includes(c))).toEqual([]);
  await finishCodes(page);
  await expect(page.getByRole("status").filter({ hasText: "New backup codes saved." })).toBeVisible();

  // An old backup code no longer turns two-factor off; a new one does.
  await page.getByRole("button", { name: "Turn off" }).click();
  await dialog(page).getByRole("button", { name: "Use a backup code" }).click();
  const backup = dialog(page).getByLabel("Backup code");
  await expect(backup).toBeFocused();
  await backup.fill(old[0]);
  await dialog(page).getByRole("button", { name: "Turn off" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("That backup code didn’t work. Check it, or use your authenticator app.");
  await backup.fill(fresh[0].toUpperCase().replace("-", " "));
  await expect(backup).toHaveValue(fresh[0]);
  await dialog(page).getByRole("button", { name: "Turn off" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(state(page)).toHaveText("Off");
});

test("turns two-factor off with a code from the app", async ({ page }) => {
  await signIn(page);
  const { secret } = await enable(page);

  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Turn off two-factor authentication" })).toBeVisible();
  await codeInput(page).fill(wrongCode(secret));
  await expect(dialog(page).getByRole("alert")).toContainText("Wrong code.");
  await expect(state(page)).toHaveText("On");
  await codeInput(page).fill(totp(secret));
  await expect(dialog(page)).toBeHidden();
  await expect(state(page)).toHaveText("Off");
  await expect(page.getByRole("status").filter({ hasText: "Two-factor authentication is off." })).toBeVisible();
  await page.reload();
  await expect(state(page)).toHaveText("Off");
});

test("an old sign-in is asked to sign in again before turning two-factor on", async ({ page }) => {
  await signIn(page, { stale: true });
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("For your security, sign in again before turning on two-factor authentication.");
  await dialog(page).getByRole("button", { name: "Sign in again" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === SECURITY);
});

// Visual check (light/dark at 1440 and 390): `TWO_FACTOR_SHOTS=<dir> pnpm test:e2e:fake two-factor-settings`.
test("screenshots", async ({ page }) => {
  const dir = process.env.TWO_FACTOR_SHOTS;
  test.skip(!dir, "set TWO_FACTOR_SHOTS to a directory to capture screenshots");
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(state(page)).toBeVisible();
      const on = (await state(page).textContent()) === "On";
      await page.screenshot({ path: `${dir}/tf-card-${on ? "on" : "off"}-${theme}-${width}.png` });
      if (!on) {
        await page.getByRole("button", { name: "Turn on" }).click();
        await expect(dialog(page).getByTestId("tf-secret")).toBeVisible();
        await page.screenshot({ path: `${dir}/tf-enable-${theme}-${width}.png` });
        const secret = (await dialog(page).getByTestId("tf-secret").textContent())?.replace(/\s/g, "") ?? "";
        await codeInput(page).fill(totp(secret));
        await expect(dialog(page).getByRole("heading", { name: "Save your backup codes" })).toBeVisible();
        await page.screenshot({ path: `${dir}/tf-codes-${theme}-${width}.png` });
        await finishCodes(page);
        await page.screenshot({ path: `${dir}/tf-card-on-${theme}-${width}.png` });
      } else {
        await page.getByRole("button", { name: "Turn off" }).click();
        await page.screenshot({ path: `${dir}/tf-disable-${theme}-${width}.png` });
        await page.keyboard.press("Escape");
      }
    }
  }
});
