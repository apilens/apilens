// Changes (#597) against the fake identity (e2e-fake/fake-identity.ts), which plays the query role:
// `GET /deploys/changes?project=shop` answers what `/__fake/deploys` seeded, and `/__fake/query-down`
// makes it answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const CHANGES = "/project/shop/changes";

async function seed(deploys: Record<string, unknown>[]) {
  const res = await fetch(`${IDENTITY}/__fake/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", deploys }),
  });
  expect(res.status).toBe(204);
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", down }),
  });
}

async function signIn(page: Page) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: CHANGES }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === CHANGES);
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const side = (requests: number, error_rate: number, p95_ms: number) => ({ requests, error_rate, p95_ms });

const DEPLOYS = [
  // Ten minutes ago: still collecting, and slower with more errors.
  {
    deployed_at: ago(10),
    release: "v2.5.0",
    commit: "4bf92f3577b34da6a3ce929d0e0e4736",
    environment: "production",
    url: "",
    app_id: "",
    before: side(1200, 0.004, 120),
    after: side(180, 0.034, 168),
    after_partial: true,
  },
  // Yesterday: faster and fewer errors.
  {
    deployed_at: ago(26 * 60),
    release: "v2.4.1",
    commit: "9c1e2d7",
    environment: "production",
    url: "",
    app_id: "",
    before: side(5400, 0.05, 200),
    after: side(5100, 0.01, 150),
    after_partial: false,
  },
  // Staging, no traffic before: nothing to compare.
  {
    deployed_at: ago(3 * 24 * 60),
    release: "v2.4.0-rc.1",
    commit: "",
    environment: "staging",
    url: "",
    app_id: "",
    before: side(0, 0, 0),
    after: side(40, 0, 90),
    after_partial: false,
  },
];

const table = (page: Page) => page.getByRole("table", { name: "Deploys" });
const rows = (page: Page) => table(page).locator("tbody tr");

test.afterEach(async () => {
  await queryDown(false);
});

test("lists deploys with before → after error rate and p95, colored by the change", async ({ page }) => {
  await seed(DEPLOYS);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Deploys" })).toBeVisible();
  await expect(table(page).getByRole("columnheader")).toHaveText(["Release", "Deployed", "Error rate", "p95 latency", "Explore"]);
  await expect(rows(page)).toHaveCount(3);

  const recent = rows(page).nth(0);
  await expect(recent.getByRole("cell").nth(0)).toHaveText("v2.5.04bf92f3All appsproduction");
  await expect(recent.getByRole("cell").nth(1)).toContainText("10m ago");
  await expect(recent.getByRole("cell").nth(1)).toContainText(/After: (9|10) min so far/);
  await expect(recent.getByRole("cell").nth(2)).toContainText("0.4%→3.4%");
  await expect(recent.getByRole("cell").nth(3)).toContainText("120 ms→168 ms");
  const worse = recent.locator(".ch-delta");
  await expect(worse).toHaveText(["+3.0 pp (worse)", "+48 ms (+40%) (worse)"]);
  for (const d of await worse.all()) await expect(d).toHaveAttribute("data-tone", "worse");

  const better = rows(page).nth(1).locator(".ch-delta");
  await expect(better).toHaveText(["−4.0 pp (better)", "−50 ms (−25%) (better)"]);
  for (const d of await better.all()) await expect(d).toHaveAttribute("data-tone", "better");

  // Worse and better use different token colors; neither is the plain ink.
  const color = (i: number, j: number) => rows(page).nth(i).locator(".ch-delta").nth(j).evaluate((el) => getComputedStyle(el).color);
  expect(await color(0, 0)).not.toBe(await color(1, 0));

  const staging = rows(page).nth(2);
  await expect(staging.getByRole("cell").nth(2)).toContainText("–→0%");
  await expect(staging.getByRole("cell").nth(2)).toContainText("No traffic to compare");

  // Explore over the hour after the deploy, in its environment (Explore has no release filter).
  await expect(recent.getByRole("link", { name: "Explore requests after v2.5.0" })).toHaveAttribute("href", /^\/project\/shop\/explore\?range=1h&from=[^&]+&to=[^&]+&env=production$/);
  await expect(staging.getByRole("link", { name: "Explore requests after v2.4.0-rc.1" })).toHaveAttribute("href", /&env=staging$/);
  // The release is the row's link to the deploy's own page.
  await expect(recent.getByRole("link", { name: "v2.5.0", exact: true })).toHaveAttribute("href", /^\/project\/shop\/changes\/[0-9a-f]+$/);

  const a11y = await new AxeBuilder({ page }).include(".ch").analyze();
  expect(a11y.violations).toEqual([]);
});

test("says so when there are no deploys", async ({ page }) => {
  await seed([]);
  await signIn(page);
  await expect(page.getByRole("status").filter({ hasText: "No deploys in the last 7 days." })).toBeVisible();
  await expect(table(page)).toHaveCount(0);
});

async function seedApps(apps: Record<string, unknown>[]) {
  const res = await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
  expect(res.status).toBe(204);
}

const report = (framework: string) => ({
  environment: "production",
  framework,
  framework_version: "1",
  runtime_version: "1",
  sdk_version: "0.1.0",
  config: {},
  received_at: ago(5),
});

test("no deploys: the release and commit snippets for the project's SDKs, with links to SDK setup and Integrations", async ({ page }) => {
  await seed([]);
  await seedApps([
    { id: "11111111-1111-4111-8111-111111111111", slug: "orders", name: "Orders", environments: [report("spring-boot")] },
    { id: "22222222-2222-4222-8222-222222222222", slug: "web", name: "Web", environments: [report("fastapi")] },
  ]);
  try {
    await signIn(page);
    await expect(page.getByRole("heading", { level: 1, name: "Deploys" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Deploys" })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveTitle(/Deploys/);

    // One tab per SDK the apps run, the first app's first; arrow keys switch.
    const record = page.getByRole("region", { name: "Record your deploys" });
    const tabs = record.getByRole("tablist", { name: "SDK" }).getByRole("tab");
    await expect(tabs).toHaveText(["Java", "Python"]);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    const panel = record.getByRole("tabpanel");
    await expect(panel).toContainText("apilens.release=${GIT_SHA:}");
    await expect(panel).toContainText("apilens.commit=${GIT_SHA:}");
    await expect(panel).toContainText("export APILENS_RELEASE=$GIT_SHA");
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(panel).toContainText('release=os.environ.get("GIT_SHA", "")');

    await expect(record.getByRole("link", { name: "Release and commit in SDK setup" })).toHaveAttribute("href", "/project/shop/settings/sdk#release");
    await expect(record.getByRole("link", { name: "Link your repository in Integrations" })).toHaveAttribute("href", "/project/shop/settings/integrations");

    const a11y = await new AxeBuilder({ page }).include(".ch").analyze();
    expect(a11y.violations).toEqual([]);

    // Every SDK when no app reported a framework.
    await seedApps([]);
    await page.reload();
    await expect(record.getByRole("tablist", { name: "SDK" }).getByRole("tab")).toHaveText(["Python", "Node.js", "Java"]);
    await record.getByRole("tab", { name: "Node.js" }).click();
    await expect(record.getByRole("tabpanel")).toContainText("release: process.env.GIT_SHA");

    // A filter that matches nothing is not "no deploys": no setup card.
    await page.goto(`${CHANGES}?env=staging`);
    await expect(page.getByRole("status").filter({ hasText: "No deploys of any app in staging" })).toBeVisible();
    await expect(record).toHaveCount(0);
  } finally {
    await seedApps([]);
  }
});

test("says so when the query API cannot answer, with a way to try again", async ({ page }) => {
  await seed(DEPLOYS);
  await queryDown(true);
  await signIn(page);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load deploys just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(3);
});

test("stacks each deploy at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(DEPLOYS);
  await signIn(page);
  await expect(rows(page)).toHaveCount(3);
  const overflow = await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
