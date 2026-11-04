// The whole onboarding funnel against the real stack (#338), the way a new user walks it: sign up,
// verify with the code read from the dev Mailpit API, create an organization and a project, take
// the ingest key the install step shows, send a first request to the stack's edge with it, see it
// on "Your first requests", invite a teammate (whose invitation lands in Mailpit) and end on the
// project. Every address is a unique @example.com one; mail never leaves Mailpit.
//
//   APILENS_E2E_UI_URL       the dashboard (default http://localhost:3200)
//   APILENS_E2E_MAILPIT_URL  Mailpit's HTTP API (default http://localhost:8025)
//   APILENS_E2E_EDGE_URL     the ingest edge (default http://localhost:8080)
import { type Page, expect, test } from "@playwright/test";

const MAILPIT = (process.env.APILENS_E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");
const EDGE = (process.env.APILENS_E2E_EDGE_URL ?? "http://localhost:8080").replace(/\/$/, "");

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

/** The plain-text body of Mailpit message `id`. */
async function mailText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`mailpit message: HTTP ${res.status}`);
  return ((await res.json()) as { Text: string }).Text;
}

/** Fills a name on the create organization/project step and waits for the slug to be free. */
async function name(page: Page, value: string) {
  await page.getByLabel("Name", { exact: true }).fill(value);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
}

const at = (page: Page, path: string, timeout?: number) => page.waitForURL((url) => url.pathname === path, { timeout });

test("sign-up → verify → organization → project → key → first event → invite → project", async ({ page }) => {
  test.setTimeout(90_000);
  // A unique suffix so reruns against the same stack never collide on emails or slugs.
  const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const email = `e2e-onboarding-${RUN}@example.com`;
  const teammate = `e2e-teammate-${RUN}@example.com`;
  const org = `E2E Org ${RUN}`;
  const project = `E2E Project ${RUN}`;
  const projectSlug = `e2e-project-${RUN}`;

  // Sign up and verify with the emailed code.
  await page.goto("/sign-up");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/verify\?/);
  const [codeMail] = await mailTo(email);
  const code = codeMail.Subject.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code in subject: ${codeMail.Subject}`);
  await page.getByLabel("6-digit code").fill(code);
  await at(page, "/onboarding/about");

  // About, then the join step is skipped (nobody else at this address's domain to join).
  await page.getByRole("button", { name: "Continue" }).click();
  // On a shared stack an earlier run may have left an organization to join; create our own then.
  const naming = page.getByRole("heading", { name: "Name your organization" });
  const separate = page.getByRole("link", { name: "Create a separate organization" });
  await expect(naming.or(separate)).toBeVisible();
  if (await separate.isVisible()) await separate.click();
  await expect(naming).toBeVisible();

  // Organization and project.
  await name(page, org);
  await page.getByRole("button", { name: "Create organization" }).click();
  await at(page, "/onboarding/project");
  await name(page, project);
  await page.getByRole("button", { name: "Create project" }).click();
  await at(page, "/onboarding/instrument");

  // Instrument with the APILens SDK, then take the key the install step shows once.
  await page.getByRole("radio", { name: "Python", exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: /^APILens SDK/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await at(page, "/onboarding/install");
  const keyField = page.getByRole("textbox", { name: "Ingest key" });
  await expect(keyField).toHaveValue(/^apl_live_[\w-]+$/);
  const key = await keyField.inputValue();
  const snippet = await page.locator(".ob-code pre").filter({ hasText: "ApiLensMiddleware" }).innerText();
  const appId = snippet.match(/app_id="([^"]+)"/)?.[1];
  if (!appId) throw new Error(`no app_id in snippet: ${snippet}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await at(page, "/onboarding/waiting");
  await expect(page.getByRole("heading", { name: "Waiting for your first request" })).toBeVisible();

  // The first event: one request to the stack's edge with that key, as the SDK sends it.
  const res = await fetch(`${EDGE}/v1/requests`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        { app_id: appId, timestamp: new Date().toISOString(), environment: "e2e", method: "GET", path: `/e2e/${RUN}`, status_code: 200, response_time_ms: 21 },
      ],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toMatchObject({ accepted: 1 });

  // The waiting screen moves on by itself; the request is read back through the query API.
  await at(page, "/onboarding/first-data", 30_000);
  await expect(page.getByRole("heading", { name: "Your first requests" })).toBeVisible();
  const rows = page.getByRole("table", { name: "Latest requests" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`/e2e/${RUN}`);
  await expect(rows.first()).toContainText("200");

  // Invite a teammate: the invitation is emailed (to Mailpit) with a link to accept it.
  await page.getByRole("button", { name: "Invite your team" }).click();
  await at(page, "/onboarding/invite");
  await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
  await page.getByLabel("Email addresses").fill(teammate);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("heading", { name: "1 invitation sent", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: teammate })).toContainText("Invitation sent");
  const [invite] = await mailTo(teammate);
  expect(await mailText(invite.ID)).toMatch(/\/invite\/[^\s/]+/);

  // Done: onboarding finishes on the project's home view and its pages no longer apply.
  await page.getByRole("button", { name: "Open project" }).click();
  await at(page, `/${projectSlug}/incidents`);
  await page.goto("/onboarding/invite");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
});
