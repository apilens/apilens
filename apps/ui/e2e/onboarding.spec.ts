// Onboarding against the real stack (#338), the way a new user walks it: sign up, verify with the
// code read from the dev Mailpit API, then Welcome (the only onboarding screen) creates an
// organization with its first project and lands in it. Every address is a unique @example.com
// one; mail never leaves Mailpit.
//
//   APILENS_E2E_UI_URL       the dashboard (default http://localhost:3200)
//   APILENS_E2E_MAILPIT_URL  Mailpit's HTTP API (default http://localhost:8025)
import { type Page, expect, test } from "@playwright/test";

const MAILPIT = (process.env.APILENS_E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Messages Mailpit holds for `to`, newest first; waits until there is at least one. */
async function mailTo(to: string): Promise<MailpitSummary[]> {
  let messages: MailpitSummary[] = [];
  await expect
    .poll(
      async () => {
        const res = await fetch(`${MAILPIT}/api/v1/search?${new URLSearchParams({ query: `to:"${to}"` })}`);
        if (!res.ok) throw new Error(`mailpit search: HTTP ${res.status}`);
        messages = ((await res.json()) as { messages?: MailpitSummary[] }).messages ?? [];
        return messages.length;
      },
      { message: `email to ${to}`, timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return [...messages].sort((a, b) => b.Created.localeCompare(a.Created));
}

const at = (page: Page, path: string | RegExp, timeout?: number) =>
  page.waitForURL((url) => (typeof path === "string" ? url.pathname === path : path.test(url.pathname)), { timeout });

test("sign-up → verify → Welcome → organization with its first project", async ({ page }) => {
  test.setTimeout(90_000);
  // A unique suffix so reruns against the same stack never collide on emails or slugs.
  const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const email = `e2e-onboarding-${RUN}@example.com`;
  const org = `E2E Org ${RUN}`;

  // Sign up and verify with the emailed code.
  await page.goto("/sign-up");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/verify\?/);
  const [codeMail] = await mailTo(email);
  const code = codeMail.Subject.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code in subject: ${codeMail.Subject}`);
  await page.getByLabel("6-digit code").fill(code);
  await at(page, "/onboarding/welcome");

  // Welcome is the only screen: no step bar, no Back.
  await expect(page.getByRole("heading", { name: "Welcome to APILens" })).toBeVisible();
  await expect(page.locator(".ob-steps")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back" })).toHaveCount(0);

  // On a shared stack an earlier run may have left an organization to join: create our own anyway.
  await page.getByTestId("welcome-create").click();
  await page.getByLabel("Full name").fill("E2E Onboarding");
  await page.getByLabel("Organization name").fill(org);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();

  // The organization comes with its first project, and that is where the user lands.
  await at(page, /^\/project\/my-api[\w-]*\/traffic$/);

  // Onboarding is finished: Welcome sends the user back to the project, and no second organization is offered.
  await page.goto("/onboarding/welcome");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
});
