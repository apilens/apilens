// Organization settings › Audit log (#813) against the fake identity (e2e-fake/fake-identity.ts) and
// its measured audit seed (40 events over three weeks: 35 on shop, 5 org-wide): the tab for owners
// and admins only, the Project filter and column, and the CSV export of the current filter. The
// table, detail panel and other filters are Access › Activity's (access-activity.spec.ts). No
// email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PATH = "/orgs/acme/settings/audit";

async function seedAudit(body: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string, role: "owner" | "admin" | "member" | "viewer" = "owner") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, role }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Organization settings" });
const log = (page: Page) => page.getByRole("region", { name: "Activity log", exact: true });
const rows = (page: Page) => log(page).locator("tbody tr.acl-row");
const projectCells = (page: Page) => rows(page).locator("td[data-label=Project]");

test.beforeEach(async () => {
  await seedAudit();
});
test.afterAll(async () => {
  await seedAudit();
});

test("owners and admins get the Audit log tab; members and viewers don't, and a direct link says why", async ({ page }) => {
  await signIn(page, "/orgs/acme/settings", "admin");
  await expect(tabs(page).getByRole("link")).toHaveText(["General", "Members", "Invitations", "Single sign-on", "Audit log"]);
  await tabs(page).getByRole("link", { name: "Audit log" }).click();
  await page.waitForURL((url) => url.pathname === PATH);
  await expect(tabs(page).getByRole("link", { name: "Audit log" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(rows(page)).toHaveCount(25);

  await signIn(page, "/orgs/acme/settings", "member");
  await expect(tabs(page).getByRole("link")).toHaveText(["General", "Members", "Invitations", "Single sign-on"]);
  const res = await page.goto(PATH);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "You can’t see this organization’s audit log" })).toBeVisible();
  await expect(log(page)).toHaveCount(0);
});

test("lists org-wide and project events with a Project column, and filters by project in the URL", async ({ page }) => {
  await signIn(page, `${PATH}?group=access`);
  await expect(log(page).getByRole("columnheader", { name: "Project" })).toBeVisible();
  // Org-wide invitations, role changes and SSO sit next to shop's access changes.
  await expect(rows(page)).toHaveCount(13);
  await expect(projectCells(page).filter({ hasText: "Organization" })).toHaveCount(5);
  await expect(rows(page).first().getByRole("button")).toHaveText("Ada Admin changed tom@example.com’s role to Editor");
  await expect(projectCells(page).first()).toHaveText(/^shop$/i);

  await log(page).getByLabel("Project").selectOption({ label: "shop" });
  await page.waitForURL((url) => url.searchParams.get("project") === "shop" && url.searchParams.get("group") === "access");
  await expect(rows(page)).toHaveCount(8);
  await expect(projectCells(page)).toHaveText(Array(8).fill(/^shop$/i));

  // The detail panel names the project too.
  await rows(page).first().getByRole("button").click();
  const panel = page.getByRole("dialog", { name: "Ada Admin changed tom@example.com’s role to Editor" });
  await expect(panel.getByRole("definition").filter({ hasText: /^shop$/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await log(page).getByLabel("Project").selectOption({ label: "All projects" });
  await page.waitForURL((url) => !url.searchParams.has("project"));
  await expect(rows(page)).toHaveCount(13);

  // A project the organization does not have is dropped, not an error.
  await page.goto(`${PATH}?project=nope&group=access`);
  await expect(log(page).getByLabel("Project")).toHaveValue("");
  await expect(rows(page)).toHaveCount(13);
});

test("exports the current filter, across the organization or for one project", async ({ page }) => {
  await signIn(page, PATH);
  const csv = async (href: string) => {
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain("attachment");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toMatch(/^timestamp,action,/);
    return lines.slice(1);
  };

  expect(await log(page).getByRole("link", { name: "Export CSV" }).getAttribute("href")).toBe("/api/orgs/acme/audit-export");
  const all = await csv("/api/orgs/acme/audit-export");
  expect(all).toHaveLength(40);

  await log(page).getByLabel("Project").selectOption({ label: "shop" });
  await page.waitForURL((url) => url.searchParams.get("project") === "shop");
  await log(page).getByLabel("Action").selectOption({ label: "API keys" });
  await page.waitForURL((url) => url.searchParams.get("group") === "keys");
  const href = await log(page).getByRole("link", { name: "Export CSV" }).getAttribute("href");
  expect(href).toBe("/api/orgs/acme/audit-export?project=shop&group=keys");
  const keys = await csv(href!);
  expect(keys).toHaveLength(6);
  expect(keys.every((l) => l.split(",")[1].startsWith("api_key."))).toBe(true);
  expect(await csv("/api/orgs/acme/audit-export?project=shop")).toHaveLength(35);

  const multi = await page.request.get("/api/orgs/acme/audit-export?group=access");
  expect(multi.status()).toBe(422);
});

test("empty and error states", async ({ page }) => {
  await seedAudit({ events: [] });
  await signIn(page, PATH);
  await expect(log(page).getByRole("heading", { name: "No activity yet" })).toBeVisible();

  await seedAudit({ down: true });
  await page.reload();
  await expect(page.locator("p[role=alert]")).toHaveText("Couldn’t load the activity log. Reload the page to try again.");
});

// Visual check (light/dark at 1440 and 390): `ORG_AUDIT_SHOTS=<dir> pnpm test:e2e:fake org-audit`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ORG_AUDIT_SHOTS;
  test.skip(!dir, "set ORG_AUDIT_SHOTS to a directory to capture screenshots");
  await signIn(page, PATH);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(PATH);
      await expect(rows(page)).toHaveCount(25);
      await page.screenshot({ path: `${dir}/org-audit-${theme}-${width}.png` });
    }
  }
});
