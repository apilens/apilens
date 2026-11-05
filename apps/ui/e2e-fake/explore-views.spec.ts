// Explore saved views (#589) against the fake identity (e2e-fake/fake-identity.ts), which plays the
// query role: `/api/v1/projects/shop/views` keeps shop's views as internal/query/saved_views.go does;
// `/__fake/views` seeds them and can make their writes answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/explore";
const SOMEONE = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const ROWS = [
  { timestamp: ago(200), method: "GET", path: "/orders/{id}", raw_path: "/orders/1", status_code: 200, response_time_ms: 42, response_size: 120, environment: "production", sampled: true, trace_id: "t0001" },
  { timestamp: ago(400), method: "POST", path: "/charge", raw_path: "/charge", status_code: 502, response_time_ms: 900, response_size: 88, environment: "production", sampled: true, trace_id: "t0002" },
];

async function post(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

const seedViews = (views: Record<string, unknown>[] = [], down = false) => post("/__fake/views", { views, down });

async function signIn(page: Page, next: string, role?: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...(role ? { role } : {}) }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const switcher = (page: Page) => page.getByRole("button", { name: /^View: / });
const menu = (page: Page) => page.getByRole("menu", { name: "Saved views" });
const status = (page: Page) => page.locator(".ex-views__said");

async function saveView(page: Page, name: string, shared = false) {
  await page.getByRole("button", { name: "Save view" }).click();
  const dialog = page.getByRole("dialog", { name: "Save these filters as a view" });
  await dialog.getByLabel("View name").fill(name);
  if (shared) await dialog.getByLabel("Share with everyone in the project").check();
  await dialog.getByRole("button", { name: "Save view" }).click();
}

test.beforeEach(async () => {
  await post("/__fake/requests", { project: "shop", rows: ROWS });
  await seedViews();
});

test.afterAll(async () => {
  await seedViews();
  await post("/__fake/requests", { project: "shop", rows: null });
});

test("saves the filters as a shared view, which the switcher shows after a reload", async ({ page }) => {
  await signIn(page, `${PAGE}?status=5xx`);
  await expect(switcher(page)).toHaveAccessibleName("View: Unsaved filters");

  await saveView(page, "  Charge failures ", true);
  await expect(switcher(page)).toHaveAccessibleName("View: Charge failures Shared");
  await expect(switcher(page).getByText("Shared")).toBeVisible();
  await expect(status(page)).toHaveText("Saved Charge failures, shared with the project.");
  // The filters are saved now, so there is nothing new to save.
  await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);

  await page.reload();
  await expect(switcher(page)).toHaveAccessibleName("View: Charge failures Shared");
  await switcher(page).click();
  await expect(menu(page).getByRole("menuitemradio", { name: /Charge failures/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu(page).getByRole("menuitemradio", { name: /Charge failures/ })).toContainText("Shared");
});

test("switches between saved views and back to all requests", async ({ page }) => {
  await seedViews([
    { name: "Production errors", filter: { env: "production", status: "5xx" }, shared: true, created_by: SOMEONE },
    { name: "Someone's private", filter: { status: "4xx" }, shared: false, created_by: SOMEONE },
  ]);
  await signIn(page, PAGE);
  await expect(switcher(page)).toHaveAccessibleName("View: All requests");

  await switcher(page).click();
  // Another user's private view is not listed.
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["All requests", "Production errorsShared"]);
  await menu(page).getByRole("menuitemradio", { name: /Production errors/ }).click();
  await page.waitForURL((u) => u.searchParams.get("env") === "production" && u.searchParams.get("status") === "5xx");
  await expect(switcher(page)).toHaveAccessibleName("View: Production errors Shared");
  await expect(page.getByRole("list", { name: "Active filters" }).getByRole("listitem").filter({ hasText: "5xx" })).toHaveCount(1);

  await switcher(page).click();
  await menu(page).getByRole("menuitemradio", { name: "All requests" }).click();
  await page.waitForURL((u) => u.search === "");
  await expect(switcher(page)).toHaveAccessibleName("View: All requests");
});

test("renames, unshares and deletes the user's own view", async ({ page }) => {
  await signIn(page, `${PAGE}?method=POST`);
  await saveView(page, "Writes", true);
  await expect(switcher(page)).toHaveAccessibleName("View: Writes Shared");

  await switcher(page).click();
  await menu(page).getByRole("menuitem", { name: "Rename view" }).click();
  const rename = page.getByRole("dialog", { name: "Rename Writes" });
  await rename.getByLabel("View name").fill(" ");
  await rename.getByRole("button", { name: "Rename view" }).click();
  await expect(rename.getByRole("alert")).toHaveText("Enter a name for the view.");
  await rename.getByLabel("View name").fill("All writes");
  await rename.getByRole("button", { name: "Rename view" }).click();
  await expect(switcher(page)).toHaveAccessibleName("View: All writes Shared");
  await expect(status(page)).toHaveText("Renamed Writes to All writes.");

  await switcher(page).click();
  const share = menu(page).getByRole("menuitemcheckbox", { name: "Share with the project" });
  await expect(share).toHaveAttribute("aria-checked", "true");
  await share.click();
  await expect(switcher(page)).toHaveAccessibleName("View: All writes");
  await expect(status(page)).toHaveText("All writes is private. Only its creator sees it.");

  await switcher(page).click();
  await menu(page).getByRole("menuitem", { name: "Delete view" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete All writes" });
  await expect(confirm).toContainText("Delete All writes?");
  await confirm.getByRole("button", { name: "Delete view" }).click();
  await expect(switcher(page)).toHaveAccessibleName("View: Unsaved filters");
  await expect(status(page)).toHaveText("Deleted All writes. The filters stay on until you change them.");
  await expect(page.getByRole("button", { name: "Save view" })).toBeVisible();

  await page.reload();
  await switcher(page).click();
  await expect(menu(page)).toContainText("No saved views yet.");
});

test("shows a shared view read-only to a viewer, and lets a project admin change it", async ({ browser }) => {
  await seedViews([{ name: "Production errors", filter: { env: "production", status: "5xx" }, shared: true, created_by: SOMEONE }]);

  const viewer = await browser.newPage();
  await signIn(viewer, `${PAGE}?env=production&status=5xx`, "viewer");
  await expect(switcher(viewer)).toHaveAccessibleName("View: Production errors Shared");
  await switcher(viewer).click();
  await expect(menu(viewer)).toContainText("Only the view’s creator or a project admin can change it.");
  for (const name of ["Rename view", "Delete view"]) await expect(menu(viewer).getByRole("menuitem", { name })).toBeDisabled();
  await expect(menu(viewer).getByRole("menuitemcheckbox", { name: "Share with the project" })).toBeDisabled();
  await viewer.close();

  const owner = await browser.newPage();
  await signIn(owner, `${PAGE}?env=production&status=5xx`);
  await switcher(owner).click();
  await menu(owner).getByRole("menuitem", { name: "Rename view" }).click();
  const rename = owner.getByRole("dialog", { name: "Rename Production errors" });
  await rename.getByLabel("View name").fill("Prod 5xx");
  await rename.getByRole("button", { name: "Rename view" }).click();
  await expect(status(owner)).toHaveText("Renamed Production errors to Prod 5xx.");
  await owner.reload();
  await expect(switcher(owner)).toHaveAccessibleName("View: Prod 5xx Shared");
  await owner.close();
});

test("shows a save at once and takes it back, with the reason, when the API refuses it", async ({ page }) => {
  await seedViews([], true);
  await signIn(page, `${PAGE}?status=5xx`);
  await saveView(page, "Errors");
  await expect(status(page)).toHaveText("Couldn’t save Errors. We couldn’t reach APILens. Check your connection and try again.");
  await expect(switcher(page)).toHaveAccessibleName("View: Unsaved filters");
  await expect(page.getByRole("button", { name: "Save view" })).toBeVisible();
});

test("refuses a name the user already uses, before calling the API", async ({ page }) => {
  await signIn(page, `${PAGE}?status=5xx`);
  await saveView(page, "Errors");
  await expect(switcher(page)).toHaveAccessibleName("View: Errors");
  // Other filters, same name.
  await page.getByRole("button", { name: /^Remove filter/ }).click();
  await page.waitForURL((u) => u.search === "");
  await page.goto(`${PAGE}?method=GET`);
  await saveView(page, "Errors");
  await expect(page.getByRole("dialog", { name: "Save these filters as a view" }).getByRole("alert")).toHaveText("You already have a view with this name.");
});

test("has no accessibility violations with the switcher open", async ({ page }) => {
  await seedViews([{ name: "Production errors", filter: { env: "production" }, shared: true, created_by: SOMEONE }]);
  await signIn(page, `${PAGE}?env=production`);
  await switcher(page).click();
  await expect(menu(page)).toBeVisible();
  const a11y = await new AxeBuilder({ page }).include(".ex").include(".org-pop").analyze();
  expect(a11y.violations).toEqual([]);
});
