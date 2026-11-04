// `/verify` against the real stack (#315): sign up, read the emailed code from the dev Mailpit
// API, then submit it. Addresses are unique @example.com ones; nothing is ever sent for real.
import { type Page, expect, test } from "@playwright/test";

const MAILPIT = (process.env.APILENS_E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Messages Mailpit holds for `to`, newest first. */
async function inbox(to: string): Promise<MailpitSummary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?${new URLSearchParams({ query: `to:"${to}"` })}`);
  if (!res.ok) throw new Error(`mailpit search: HTTP ${res.status}`);
  const body = (await res.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

/** Waits for the `nth` (1-based) code email to `to` and returns its 6-digit code. */
async function codeFor(to: string, nth = 1): Promise<string> {
  let messages: MailpitSummary[] = [];
  await expect
    .poll(async () => (messages = await inbox(to)).length, { message: `email #${nth} to ${to}`, timeout: 15_000 })
    .toBeGreaterThanOrEqual(nth);
  const newest = [...messages].sort((a, b) => b.Created.localeCompare(a.Created))[0];
  const code = newest.Subject.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code in subject: ${newest.Subject}`);
  return code;
}

/** A 6-digit code that is not `code`. */
const wrongFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

const address = (tag: string) => `e2e-verify-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function signUp(page: Page, email: string) {
  await page.goto("/sign-up");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/verify\?/);
  await expect(page.getByText(email)).toBeVisible();
}

const codeInput = (page: Page) => page.getByLabel("6-digit code");
const problem = (page: Page) => page.locator("#verify-problem");

test("signs up with the emailed code, counting wrong guesses", async ({ page }) => {
  const email = address("ok");
  await signUp(page, email);
  const code = await codeFor(email);

  await expect(codeInput(page)).toHaveAttribute("autocomplete", "one-time-code");
  await codeInput(page).fill(wrongFor(code));
  await expect(problem(page)).toHaveText("Wrong code. 4 attempts left.");
  await expect(codeInput(page)).toHaveValue("");

  await codeInput(page).fill(code);
  await expect(page).toHaveURL(/\/onboarding\/about$/);
});

test("locks after five wrong codes, then resends after the server's cooldown", async ({ page }) => {
  test.setTimeout(90_000);
  const email = address("lock");
  await signUp(page, email);
  const first = await codeFor(email);

  // The countdown starts from the server's retry_after (30 s resend cooldown).
  const resend = page.getByRole("button", { name: /Resend/ });
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/Resend in 0:[0-3]\d/);

  for (let left = 4; left >= 1; left--) {
    await codeInput(page).fill(wrongFor(first));
    await expect(problem(page)).toHaveText(`Wrong code. ${left} ${left === 1 ? "attempt" : "attempts"} left.`);
  }
  await codeInput(page).fill(wrongFor(first));
  await expect(problem(page)).toContainText("Too many wrong codes. Send a new one to continue.");
  await expect(codeInput(page)).toBeDisabled();

  await expect(resend).toHaveText("Resend code", { timeout: 40_000 });
  await resend.click();
  await expect(page.getByText("We sent a new code to")).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(codeInput(page)).toBeEnabled();

  const second = await codeFor(email, 2);
  await codeInput(page).fill(second);
  await expect(page).toHaveURL(/\/onboarding\/about$/);
});

test("without an email goes back to sign-in", async ({ page }) => {
  await page.goto("/verify");
  await expect(page).toHaveURL(/\/sign-in$/);
});
