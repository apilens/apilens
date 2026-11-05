// Project settings → Privacy (#599) against the fake identity (e2e-fake/fake-identity.ts), which
// serves shop's deny list (`GET|PUT /projects/shop/privacy-policy`, 403 on PUT without
// `project.update`). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PRIVACY = "/shop/settings/privacy";
const EDITOR = ["project.read", "project.update"];

async function signIn(page: Page, capabilities: string[] = EDITOR) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PRIVACY, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PRIVACY);
}

const form = (page: Page) => page.locator("form").filter({ has: page.getByRole("heading", { name: "Server-side deny list" }) });
const list = (page: Page, name: string) => form(page).getByRole("group", { name });
const tester = (page: Page) => page.getByRole("region", { name: "Test a request" });
const save = (page: Page) => form(page).getByRole("button", { name: "Save" });

test.beforeEach(async () => {
  await fetch(`${IDENTITY}/__fake/privacy`, { method: "POST" });
});

test("an editor adds patterns, sees them in the tester and saves", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Privacy", exact: true })).toBeVisible();
  await expect(form(page)).toContainText("Never changed: only the built-in patterns apply.");
  // Built-ins are locked rows.
  await expect(list(page, "Headers")).toContainText("x-csrf-token");
  await expect(list(page, "Headers").getByRole("list", { name: "Headers: always masked, by exact name" })).toContainText("x-csrf-token");
  await expect(list(page, "Body fields").getByRole("list", { name: "Body fields: built in, always applied" })).toContainText("card.?number");
  await expect(save(page)).toBeDisabled();

  // The sample's session_id is not masked by the built-ins.
  const url = tester(page).getByLabel("As stored").first();
  await expect(url).toHaveText("/v1/orders?page=2&api_key=[redacted]&session_id=8f3a");

  // An invalid regex is blocked with a message.
  await list(page, "Query parameters").getByRole("button", { name: "Add pattern" }).click();
  const row = list(page, "Query parameters").getByRole("textbox", { name: "Query parameters pattern 1" });
  await expect(row).toBeFocused();
  await row.fill("(session");
  await expect(list(page, "Query parameters")).toContainText("This isn’t a valid regular expression.");
  await save(page).click();
  await expect(form(page).getByRole("status")).toHaveText("Fix the highlighted patterns to save.");
  await row.fill("token(?=x)");
  await expect(list(page, "Query parameters")).toContainText("Lookarounds aren’t supported.");

  // A valid one applies in the tester before it is saved.
  await row.fill("^session_id$");
  await expect(url).toHaveText("/v1/orders?page=2&api_key=[redacted]&session_id=[redacted]");
  await save(page).click();
  await expect(form(page).getByRole("status")).toHaveText("Saved. The ingest edge applies it within 60 s.");
  await expect(form(page)).toContainText("Last changed");

  await page.reload();
  await expect(list(page, "Query parameters").getByRole("textbox", { name: "Query parameters pattern 1" })).toHaveValue("^session_id$");
});

test("a viewer sees the lists read-only and can still use the tester", async ({ page }) => {
  await signIn(page, ["project.read"]);
  await expect(page.getByText("You can see this policy. Only project owners, admins and members can change it.")).toBeVisible();
  await expect(form(page).getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(form(page).getByRole("button", { name: "Add pattern" })).toHaveCount(0);
  await tester(page).getByLabel("Body").fill('{"password":"p","name":"ada"}');
  await expect(tester(page).getByLabel("As stored").nth(2)).toHaveText('{"password":"[redacted]","name":"ada"}');
});

// Visual check (light/dark at 1440 and 390): `PRIVACY_SHOTS=<dir> pnpm test:e2e:fake privacy`.
test("screenshots", async ({ page }) => {
  const dir = process.env.PRIVACY_SHOTS;
  test.skip(!dir, "set PRIVACY_SHOTS to a directory to capture screenshots");
  await signIn(page);
  await list(page, "Headers").getByRole("button", { name: "Add pattern" }).click();
  await list(page, "Headers").getByRole("textbox").first().fill("^x-tenant-");
  await list(page, "Body fields").getByRole("button", { name: "Add pattern" }).click();
  await list(page, "Body fields").getByRole("textbox").first().fill("^(email|phone");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.screenshot({ path: `${dir}/privacy-${theme}-${width}.png`, fullPage: true });
    }
  }
});
