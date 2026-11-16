// Project access and project settings against the real stack (#828): an admin restricts a project
// and a second member loses it; the admin adds them back as Viewer and they see it read-only; the
// admin rotates the ingest key and requests sent with the old key are still accepted during the
// overlap; the admin changes an environment's settings, deletes the project and restores it from
// organization settings; the Activity tab lists each of those actions.
//
// Both people are new, unique @example.com addresses: the admin signs up and onboards (with a first
// request sent the way the SDK sends it), the teammate joins through the invitation onboarding
// sends. Sign-in codes and the invitation are read from the dev Mailpit API, so no email leaves the
// machine, and reruns against the same stack never collide.
//
//   APILENS_E2E_UI_URL       the dashboard (default http://localhost:3200)
//   APILENS_E2E_MAILPIT_URL  Mailpit's HTTP API (default http://localhost:8025)
//   APILENS_E2E_EDGE_URL     the ingest edge (default http://localhost:8080)
import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

const MAILPIT = (process.env.APILENS_E2E_MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");
const EDGE = (process.env.APILENS_E2E_EDGE_URL ?? "http://localhost:8080").replace(/\/$/, "");

// A unique suffix so reruns against the same stack never collide on emails or slugs.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const ADMIN_EMAIL = `e2e-access-admin-${RUN}@example.com`;
const TEAMMATE_EMAIL = `e2e-access-mate-${RUN}@example.com`;
const ORG = `E2E Access Org ${RUN}`;
const PROJECT = `E2E Access ${RUN}`;
const SLUG = `e2e-access-${RUN}`;
const ENVIRONMENT = "production";

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Messages Mailpit holds for `to` whose subject matches `subject`, newest first; waits for `count`. */
async function mailTo(to: string, subject: RegExp = /./, count = 1): Promise<MailpitSummary[]> {
  let messages: MailpitSummary[] = [];
  await expect
    .poll(
      async () => {
        const res = await fetch(`${MAILPIT}/api/v1/search?${new URLSearchParams({ query: `to:"${to}"` })}`);
        if (!res.ok) throw new Error(`mailpit search: HTTP ${res.status}`);
        messages = (((await res.json()) as { messages?: MailpitSummary[] }).messages ?? []).filter((m) => subject.test(m.Subject));
        return messages.length;
      },
      { message: `email to ${to} matching ${subject}`, timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(count);
  return [...messages].sort((a, b) => b.Created.localeCompare(a.Created));
}

const CODE = /\b(\d{6})\b/;

/** The newest sign-in code emailed to `to`, once there are `count` code emails. */
async function codeFor(to: string, count = 1): Promise<string> {
  const [newest] = await mailTo(to, CODE, count);
  return newest.Subject.match(CODE)?.[1] ?? "";
}

/** The plain-text body of Mailpit message `id`. */
async function mailText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`mailpit message: HTTP ${res.status}`);
  return ((await res.json()) as { Text: string }).Text;
}

/** Sends one request record to the edge with `key`, as the SDK does; returns the HTTP status. */
async function ingest(key: string, appId: string, path: string): Promise<number> {
  const res = await fetch(`${EDGE}/v1/requests`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ app_id: appId, timestamp: new Date().toISOString(), environment: ENVIRONMENT, method: "GET", path, status_code: 200, response_time_ms: 12 }],
    }),
  });
  return res.status;
}

const at = (page: Page, path: string | RegExp, timeout?: number) =>
  page.waitForURL((url) => (typeof path === "string" ? url.pathname === path : path.test(url.pathname)), { timeout });

/** Fills a name on the create organization/project step and waits for the slug to be free. */
async function name(page: Page, value: string) {
  await page.getByLabel("Name", { exact: true }).fill(value);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
}

/** Signs `email` up with the emailed code; ends on /verify's next step. */
async function signUp(page: Page, email: string) {
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/verify\?/);
  await page.getByLabel("6-digit code").fill(await codeFor(email));
}

// What the first test sets up and the next ones use.
let admin: BrowserContext;
let mate: BrowserContext;
let adminPage: Page;
let matePage: Page;
let ingestKey = "";
let appId = "";

test.describe.configure({ mode: "serial" });

async function newPage(browser: Browser): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext();
  return [context, await context.newPage()];
}

test.beforeAll(async ({ browser }) => {
  [admin, adminPage] = await newPage(browser);
  [mate, matePage] = await newPage(browser);
});

test.afterAll(async () => {
  await admin?.close();
  await mate?.close();
});

test("setup: an admin onboards a project with a first request and a teammate joins the organization", async () => {
  test.setTimeout(120_000);
  const page = adminPage;

  await page.goto("/sign-up");
  await signUp(page, ADMIN_EMAIL);
  await at(page, "/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  const naming = page.getByRole("heading", { name: "Name your organization" });
  const separate = page.getByRole("link", { name: "Create a separate organization" });
  await expect(naming.or(separate)).toBeVisible();
  if (await separate.isVisible()) await separate.click();
  await expect(naming).toBeVisible();
  await name(page, ORG);
  await page.getByRole("button", { name: "Create organization" }).click();
  await at(page, "/onboarding/project");
  await name(page, PROJECT);
  await page.getByRole("button", { name: "Create project" }).click();
  await at(page, "/onboarding/instrument");

  await page.getByRole("radio", { name: "Python", exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: /^APILens SDK/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await at(page, "/onboarding/install");
  const keyField = page.getByRole("textbox", { name: "Ingest key" });
  await expect(keyField).toHaveValue(/^apl_live_[\w-]+$/);
  ingestKey = await keyField.inputValue();
  const snippet = await page.locator(".ob-code pre").filter({ hasText: "ApiLensMiddleware" }).innerText();
  appId = snippet.match(/app_id="([^"]+)"/)?.[1] ?? "";
  expect(appId, snippet).not.toBe("");
  await page.getByRole("button", { name: "Continue" }).click();
  await at(page, "/onboarding/waiting");

  // The first request registers the `production` environment.
  expect(await ingest(ingestKey, appId, `/e2e/${RUN}/first`)).toBe(200);
  await at(page, "/onboarding/first-data", 30_000);

  // Invite the teammate (as an organization member) and finish onboarding.
  await page.getByRole("button", { name: "Invite your team" }).click();
  await at(page, "/onboarding/invite");
  await page.getByLabel("Email addresses").fill(TEAMMATE_EMAIL);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("heading", { name: "1 invitation sent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open project" }).click();
  await at(page, `/${SLUG}/incidents`);

  // The teammate accepts the invitation with a new account.
  const [invite] = await mailTo(TEAMMATE_EMAIL, /./);
  const link = (await mailText(invite.ID)).match(/https?:\/\/\S+(\/invite\/[^\s/]+)/)?.[1];
  if (!link) throw new Error("no invitation link in the email");
  await matePage.goto(link);
  await matePage.getByRole("link", { name: "Accept invitation" }).click();
  await at(matePage, "/sign-up");
  await signUp(matePage, TEAMMATE_EMAIL);
  await at(matePage, link);
  await matePage.getByRole("button", { name: "Accept invitation" }).click();
  await at(matePage, "/onboarding/about");
  await matePage.getByRole("button", { name: /^Continue to / }).click();
  await at(matePage, new RegExp(`^/${SLUG}/`));
});

test("restricting the project takes it from the teammate; adding them as Viewer gives it back read-only", async () => {
  test.setTimeout(90_000);
  const page = adminPage;
  const general = `/${SLUG}/settings`;

  // Under the default (organization role) the teammate, an org member, edits the project.
  expect((await matePage.goto(general))?.status()).toBe(200);
  await expect(matePage.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
  await expect(matePage.getByText("You can see these settings. Only project admins and editors can change them.")).toHaveCount(0);

  // Restrict.
  await page.goto(`/${SLUG}/access`);
  const card = page.getByRole("region", { name: "Default access" });
  await card.getByRole("radio", { name: /^Restricted: only people added here/ }).check();
  await card.getByRole("button", { name: "Save default access" }).click();
  const restrict = page.getByRole("dialog", { name: `Restrict ${PROJECT}?` });
  await expect(restrict.locator('[data-impact="lose"]')).toContainText(TEAMMATE_EMAIL);
  await restrict.getByRole("button", { name: "Restrict project" }).click();
  await expect(card.getByRole("status")).toHaveText("This project is now restricted.");

  // The teammate no longer sees it (once the relationship reaches the authorization cache).
  await expect(async () => {
    expect((await matePage.goto(general))?.status()).toBe(404);
  }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });

  // Added back directly as Viewer.
  await page.getByRole("button", { name: "Add people" }).click();
  const add = page.getByRole("dialog", { name: `Add people to ${PROJECT}` });
  await add.getByRole("checkbox", { name: new RegExp(TEAMMATE_EMAIL.replace(/[.+]/g, "\\$&")) }).check();
  await add.getByRole("radio", { name: /^Viewer/ }).check();
  await add.getByRole("button", { name: "Add person" }).click();
  await expect(add).toBeHidden();
  await expect(page.locator(".am-status")).toContainText(`to ${PROJECT} as`);

  // They see it again, read-only.
  await expect(async () => {
    expect((await matePage.goto(general))?.status()).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
  await expect(matePage.getByText("You can see these settings. Only project admins and editors can change them.")).toBeVisible();
});

test("rotating the ingest key keeps the old key working during the overlap", async () => {
  const page = adminPage;
  await page.goto(`/${SLUG}/access/keys`);
  const card = page.getByRole("region", { name: "API keys" });
  const rows = card.locator("tbody tr.pk-row");
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: /^Rotate / }).click();
  const rotate = page.getByRole("dialog", { name: /^Rotate .+\?$/ });
  await expect(rotate.getByRole("radio", { name: /24 hours/ })).toBeChecked();
  await rotate.getByRole("button", { name: "Rotate key" }).click();

  const reveal = page.getByRole("dialog");
  await expect(reveal.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  const fresh = await reveal.getByRole("textbox", { name: "API key" }).inputValue();
  expect(fresh).toMatch(/^apl_live_[\w-]{20,}$/);
  expect(fresh).not.toBe(ingestKey);
  await reveal.getByRole("checkbox", { name: /I have stored this key/ }).check();
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(card.getByRole("status")).toHaveText(/^Rotated .+\. The old key works until .+ UTC\.$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByRole("cell").nth(6)).toHaveText(/^Rotating until /);

  // The app keeps sending with the old key during the overlap, and the new key works too.
  expect(await ingest(ingestKey, appId, `/e2e/${RUN}/old-key`)).toBe(200);
  expect(await ingest(fresh, appId, `/e2e/${RUN}/new-key`)).toBe(200);
});

test("an environment's settings change, and the project is deleted and restored from organization settings", async () => {
  const page = adminPage;

  // Environments: the SDK registered production; give it a colour.
  await page.goto(`/${SLUG}/settings/environments`);
  const env = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: ENVIRONMENT, exact: true }) });
  await expect(async () => {
    await page.reload();
    await expect(env).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await env.getByLabel(`Colour of ${ENVIRONMENT}`).selectOption({ label: "Teal" });
  await expect(page.getByRole("status").filter({ hasText: `${ENVIRONMENT} is teal now.` })).toBeVisible();
  await page.reload();
  await expect(env.getByLabel(`Colour of ${ENVIRONMENT}`)).toHaveValue("teal");

  // Delete, with the slug typed to confirm.
  await page.goto(`/${SLUG}/settings/danger`);
  await page.getByRole("region", { name: "Pause, rename or delete" }).getByRole("button", { name: "Delete project" }).click();
  const del = page.getByRole("dialog", { name: `Delete ${PROJECT}?` });
  await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
  await del.getByRole("textbox").fill(SLUG);
  await del.getByRole("button", { name: `Delete ${PROJECT}` }).click();
  await at(page, /^\/orgs\/[^/]+\/settings$/);
  await expect(page.getByRole("status").filter({ hasText: `Project ${SLUG} was deleted.` })).toBeVisible();
  expect((await page.request.get(`/${SLUG}/incidents`)).status()).toBe(404);

  // Restore from organization settings.
  const deleted = page.getByRole("region", { name: "Deleted projects" });
  const row = deleted.getByRole("listitem").filter({ hasText: PROJECT });
  await expect(row).toContainText("Deleted just now");
  await row.getByRole("button", { name: `Restore ${PROJECT}` }).click();
  await expect(deleted.getByRole("status").filter({ hasText: "is restored." })).toContainText(`${PROJECT} is restored.`);
  await deleted.getByRole("link", { name: `Open ${PROJECT}` }).click();
  await at(page, `/${SLUG}/incidents`);
});

test("the Activity tab lists each of those actions", async () => {
  const page = adminPage;
  await page.goto(`/${SLUG}/access/activity`);
  const log = page.getByRole("region", { name: "Activity log", exact: true });
  const events = log.locator("tbody tr.acl-row").getByRole("button");
  for (const sentence of [
    /set the project’s default access to restricted$/,
    /added .+ to the project as Viewer$/,
    /rotated key .+$/,
    new RegExp(`updated environment ${ENVIRONMENT}$`),
    new RegExp(`scheduled the deletion of project ${PROJECT}$`),
    new RegExp(`restored project ${PROJECT}$`),
  ]) {
    await expect(events.filter({ hasText: sentence }), String(sentence)).toHaveCount(1);
  }
});
