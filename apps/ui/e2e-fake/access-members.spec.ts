// Access › Members (#806) against the fake identity (e2e-fake/fake-identity.ts): the list with each
// person's effective role and where it comes from, the summary line, search, the role and source
// filters, paging in the URL, the restricted-and-empty, error states, and a viewer seeing the same
// list. The fake's measured seed is nine acme people under the `org_role` default. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const VIEWER = ["project.read"];

async function seed(body: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string, capabilities: string[] = ADMIN) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const table = (page: Page) => page.getByRole("table", { name: "People with access to Shop" });
const rows = (page: Page) => table(page).locator("tbody tr");
const row = (page: Page, name: string) => rows(page).filter({ has: page.getByRole("rowheader", { name: new RegExp(name) }) });

test.beforeEach(async () => {
  await seed();
});
test.afterAll(async () => {
  await seed();
});

test("lists everyone with their effective role and where it comes from", async ({ page }) => {
  await signIn(page, "/shop/access");
  await expect(page.getByText("9 people have access: 4 Admins, 3 Editors, 2 Viewers.")).toBeVisible();
  await expect(page.getByText("Default access: organization members can edit and organization viewers can view.")).toBeVisible();
  await expect(rows(page)).toHaveCount(9);
  await expect(table(page).locator("thead th")).toHaveText(["Person", "Role", "Source", "Last active", "Added by", "Actions"]);

  const olive = row(page, "Olive Owner");
  await expect(olive.locator('td[data-label="Role"]')).toHaveText("Admin");
  await expect(olive.locator('td[data-label="Source"] li')).toHaveText(["Organization owner"]);
  await expect(olive.locator('td[data-label="Added by"]')).toHaveText("—");

  await expect(row(page, "Max Member").locator('td[data-label="Source"] li')).toHaveText(["Organization member (project default)"]);
  await expect(row(page, "Sam Okafor").locator('td[data-label="Last active"]')).toHaveText("Never signed in");

  // Two sources: two lines, each with the role it gives; the highest wins.
  const tom = row(page, "Tom Becker");
  await expect(tom.locator('td[data-label="Role"]')).toHaveText("Editor");
  await expect(tom.locator('td[data-label="Source"] li')).toHaveText(["Organization viewer (project default) · Viewer", "Added to this project · Editor"]);
  await expect(tom.locator('td[data-label="Added by"]')).toContainText("Ada Admin");
});

test("search by name or email keeps the query in the URL", async ({ page }) => {
  await signIn(page, "/shop/access");
  await page.getByRole("searchbox", { name: "Search people" }).fill("kovac");
  await page.waitForURL((url) => url.searchParams.get("q") === "kovac");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Lena Kovač")).toHaveCount(1);
  await expect(page.getByText("1 of 9 people match")).toBeVisible();

  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search people" }).fill("priya@example");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Priya Patel")).toHaveCount(1);

  await page.getByRole("searchbox", { name: "Search people" }).fill("nobody-here");
  await expect(page.getByText("Nobody matches “nobody-here”")).toBeVisible();
  await page.getByRole("link", { name: "Clear search and filters" }).click();
  await expect(rows(page)).toHaveCount(9);
});

test("filters by role and by source, in the URL", async ({ page }) => {
  await signIn(page, "/shop/access");
  await page.getByLabel("Role", { exact: true }).selectOption("editor");
  await page.waitForURL((url) => url.searchParams.get("role") === "editor");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText("3 of 9 people match")).toBeVisible();

  await page.getByLabel("Source", { exact: true }).selectOption("direct");
  await page.waitForURL((url) => url.searchParams.get("source") === "direct" && url.searchParams.get("role") === "editor");
  await expect(rows(page).locator("th")).toHaveText([/Lena Kovač/, /Tom Becker/]);

  await page.goto("/shop/access?source=org_role");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByLabel("Source", { exact: true })).toHaveValue("org_role");
});

test("pages through a long list with the page in the URL", async ({ page }) => {
  const members = Array.from({ length: 30 }, (_, i) => ({
    user_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Person ${String(i + 1).padStart(2, "0")}`,
    email: `person${String(i + 1).padStart(2, "0")}@example.com`,
    org_role: i === 0 ? "owner" : "member",
    direct_role: null,
    added_at: "2026-10-01T10:00:00Z",
    last_active_at: "2026-11-01T10:00:00Z",
  }));
  await seed({ members });
  await signIn(page, "/shop/access");
  await expect(page.getByText("30 people have access: 1 Admin, 29 Editors.")).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  const pages = page.getByRole("navigation", { name: "Members pages" });
  await pages.getByRole("link", { name: /Next/ }).click();
  await page.waitForURL((url) => url.searchParams.get("page") === "2");
  await expect(rows(page)).toHaveCount(5);
  await expect(rows(page).first().locator("th")).toContainText("Person 26");

  // A filter starts again at page 1.
  await page.getByLabel("Role", { exact: true }).selectOption("editor");
  await page.waitForURL((url) => url.searchParams.get("role") === "editor" && !url.searchParams.has("page"));
  await expect(rows(page)).toHaveCount(25);
});

test("a restricted project nobody was added to says so", async ({ page }) => {
  await seed({
    default_access: "none",
    members: [
      { user_id: "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f", name: "Fake User", email: "you@example.com", org_role: "owner", direct_role: null, added_at: "2026-10-01T10:00:00Z", last_active_at: null },
      { user_id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", name: "Max Member", email: "max@example.com", org_role: "member", direct_role: null, added_at: "2026-10-01T10:00:00Z", last_active_at: null },
    ],
  });
  await signIn(page, "/shop/access");
  await expect(page.getByText(/^Nobody has been added to shop$/i)).toBeVisible();
  await expect(page.getByText("Default access: only organization owners and admins, and people added directly.")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
});

test("an API failure says so instead of an empty list", async ({ page }) => {
  await seed({ down: true });
  await signIn(page, "/shop/access");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load" })).toHaveText(/^Couldn’t load the people with access to shop\. Reload the page to try again\.$/i);
  await expect(table(page)).toHaveCount(0);
});

test("a viewer sees the same list, read-only", async ({ page }) => {
  await signIn(page, "/shop/access", VIEWER);
  await expect(page.getByText("9 people have access: 4 Admins, 3 Editors, 2 Viewers.")).toBeVisible();
  await expect(rows(page)).toHaveCount(9);
  // Changing access (#807) is there, disabled with the reason.
  for (const b of await table(page).getByRole("button").all()) await expect(b).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add people" })).toBeDisabled();
  await expect(table(page).getByRole("combobox")).toHaveCount(0);
});

test("at 390 px each person is a card of labelled lines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "/shop/access");
  await expect(table(page).locator("thead")).toBeHidden();
  const tom = row(page, "Tom Becker");
  for (const label of ["Role", "Source", "Last active", "Added by"]) await expect(tom.locator(`td[data-label="${label}"]`)).toBeVisible();
  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(scrolls).toBe(false);
});

// Visual check (light/dark at 1440 and 390): `ACCESS_SHOTS=<dir> pnpm test:e2e:fake access-members`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ACCESS_SHOTS;
  test.skip(!dir, "set ACCESS_SHOTS to a directory to capture screenshots");
  await signIn(page, "/shop/access");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto("/shop/access");
      await expect(rows(page).first()).toBeVisible();
      await page.screenshot({ path: `${dir}/access-members-${theme}-${width}.png`, fullPage: true });
    }
  }
});
