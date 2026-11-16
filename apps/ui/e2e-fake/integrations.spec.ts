// Project settings → Integrations (#820) against the fake identity (e2e-fake/fake-identity.ts),
// which serves shop with its repository link (`GET|PATCH /projects/shop`, 403 on PATCH without
// `project.update`, invalid_request with the API's reason for a refused link) and the deploys
// `/__fake/deploys` seeds. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const INTEGRATIONS = "/shop/settings/integrations";
const EDITOR = ["project.read", "project.update"];
const VIEWER = ["project.read"];
const COMMIT = "4bf92f3577b34da6a3ce929d0e0e4736";

async function signIn(page: Page, capabilities: string[] = EDITOR) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: INTEGRATIONS, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === INTEGRATIONS);
}

async function seedDeploy() {
  const side = (requests: number, error_rate: number, p95_ms: number) => ({ requests, error_rate, p95_ms });
  const res = await fetch(`${IDENTITY}/__fake/deploys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "shop",
      deploys: [
        {
          deployed_at: new Date(Date.now() - 90 * 60_000).toISOString(),
          release: "v2.5.0",
          commit: COMMIT,
          environment: "production",
          url: "",
          app_id: "",
          before: side(1200, 0.004, 120),
          after: side(1100, 0.003, 110),
          after_partial: false,
        },
      ],
    }),
  });
  expect(res.status).toBe(204);
}

const card = (page: Page) => page.locator("form").filter({ has: page.getByRole("heading", { name: "Source repository" }) });
const field = (page: Page) => page.getByLabel("Repository URL");

test.beforeEach(async () => {
  await fetch(`${IDENTITY}/__fake/repository`, { method: "POST" });
});

test.afterAll(async () => {
  await fetch(`${IDENTITY}/__fake/repository`, { method: "POST" });
  await fetch(`${IDENTITY}/__fake/deploys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", deploys: [] }) });
});

test("a host the API refuses shows its reason next to the field", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  await field(page).fill("https://git.example.com/acme/shop");
  await card(page).getByRole("button", { name: "Save" }).click();
  const reason = card(page).getByText("The repository must be on github.com, gitlab.com or bitbucket.org.");
  await expect(reason).toBeVisible();
  await expect(field(page)).toHaveAttribute("aria-invalid", "true");
  await expect(field(page)).toHaveAttribute("aria-describedby", (await reason.getAttribute("id")) ?? "");
  await expect(card(page).getByRole("status")).toHaveText("Repository link not saved.");

  // A link the browser can tell is wrong never reaches the API.
  await field(page).fill("http://github.com/acme/shop");
  await expect(card(page).getByText("The repository link must start with https://.")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Save" })).toBeDisabled();
});

test("a saved repository URL turns a commit on Changes into a link", async ({ page }) => {
  await seedDeploy();
  await signIn(page);
  await field(page).fill("https://github.com/acme/shop.git");
  await expect(card(page)).toContainText("A commit links to https://github.com/acme/shop/commit/4bf92f3");
  await card(page).getByRole("button", { name: "Save" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Repository link saved.");
  await expect(field(page)).toHaveValue("https://github.com/acme/shop");

  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);

  // Notifications point at Alert channels.
  await page.getByRole("link", { name: "Go to Alert channels" }).click();
  await page.waitForURL((url) => url.pathname === "/shop/settings/alerts");

  await page.goto("/shop/changes");
  const commit = page.getByRole("link", { name: "Commit 4bf92f3 in the repository" });
  await expect(commit).toHaveAttribute("href", `https://github.com/acme/shop/commit/${COMMIT}`);
  await expect(commit).toHaveAttribute("target", "_blank");
  await expect(commit).toHaveAttribute("rel", "noreferrer");

  // Removing the link leaves commit ids as text.
  await page.goto(INTEGRATIONS);
  await card(page).getByRole("button", { name: "Remove" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Repository link removed.");
  await page.goto("/shop/changes");
  await expect(page.getByRole("row").filter({ hasText: "v2.5.0" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Commit 4bf92f3 in the repository" })).toHaveCount(0);
});

test("a viewer sees the link read-only", async ({ page }) => {
  await signIn(page, VIEWER);
  await expect(page.getByText("Only project admins and editors can change them.")).toBeVisible();
  await expect(field(page)).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "Save" })).toHaveCount(0);
});
