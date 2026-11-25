// Creating an organization and a project after onboarding (/organizations/new,
// /org/<org>/projects/new) against the fake identity: the scope menu and the organization's
// Projects page lead there, and a created one opens.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";

async function signIn(page: Page, next: string, role: "owner" | "member" | "viewer" = "owner") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, role }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

test("the organization menu leads to the create page, which creates one", async ({ page }) => {
  await signIn(page, "/organizations");
  await page.getByRole("link", { name: "New organization" }).click();
  await page.waitForURL((url) => url.pathname === "/organizations/new");

  await page.getByLabel("Organization name").fill("Side Project Labs");
  await expect(page.getByText("side-project-labs")).toBeVisible();
  const create = page.getByRole("button", { name: "Create organization" });
  await expect(create).toBeEnabled();
  await create.click();
  await page.waitForURL((url) => url.pathname === "/org/side-project-labs");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
});

test("an organization with no projects offers to create the first one", async ({ page }) => {
  await signIn(page, "/organizations");
  await page.getByRole("link", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Empty Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/org/empty-org");

  await expect(page.getByText("No projects in Empty Org yet")).toBeVisible();
  await page.getByRole("link", { name: "Create your first project" }).click();
  await page.waitForURL((url) => url.pathname === "/org/empty-org/projects/new");
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
});

test("the project menu leads to the create page, which creates one and opens it", async ({ page }) => {
  await signIn(page, "/org/acme");
  await page.getByRole("link", { name: "New project" }).click();
  await page.waitForURL((url) => url.pathname === "/org/acme/projects/new");

  await page.getByLabel("Project name").fill("Payments Service");
  await expect(page.getByText("payments-service")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "production" })).toBeVisible();
  const create = page.getByRole("button", { name: "Create project" });
  await expect(create).toBeEnabled();
  await create.click();
  // A project with no data opens its SDK setup, not an empty dashboard.
  await page.waitForURL((url) => url.pathname === "/project/payments-service/settings/sdk");
});

test("an address another project holds is reported on the field", async ({ page }) => {
  await signIn(page, "/org/acme/projects/new");
  await page.getByLabel("Project name").fill("Shop");
  await expect(page.getByText(/taken/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create project" })).toBeDisabled();
});

test("a member may create a project, as the API allows", async ({ page }) => {
  await signIn(page, "/org/acme", "member");
  await expect(page.getByRole("link", { name: "New project" })).toBeVisible();
  await page.goto("/org/acme/projects/new");
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
});

test("a viewer cannot reach the project create page", async ({ page }) => {
  await signIn(page, "/org/acme", "viewer");
  await expect(page.getByRole("link", { name: "New project" })).toHaveCount(0);
  await page.goto("/org/acme/projects/new");
  await expect(page.getByRole("heading", { name: "Create a project" })).toHaveCount(0);
  await expect(page.getByText("404")).toBeVisible();
});
