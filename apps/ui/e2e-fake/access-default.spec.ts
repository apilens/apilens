// Access › Members › Default access (#808) against the fake identity (e2e-fake/fake-identity.ts):
// every transition between the three defaults, the dry run's count and names in the confirmation,
// cancel leaving the setting unchanged, the "Restricted" label, a stale sign-in, and a viewer
// seeing the setting read-only. The fake's measured seed is nine acme people under `org_role`:
// three of them (Max, Vera, Sam) have access only through the default. No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const VIEWER = ["project.read"];

async function seed(body: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, capabilities: string[] = ADMIN, stale = false) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: "/shop/access", capabilities, stale }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === "/shop/access");
}

const card = (page: Page) => page.getByRole("region", { name: "Default access" });
const choice = (page: Page, name: RegExp) => card(page).getByRole("radio", { name });
const FOLLOW = /^Follow organization role/;
const VIEW = /^Everyone in Acme can view/;
const RESTRICTED = /^Restricted: only people added here/;
const save = (page: Page) => card(page).getByRole("button", { name: "Save default access" });
const status = (page: Page) => card(page).getByRole("status");
const label = (page: Page) => page.locator(".os-head .da-restricted");
const summary = (page: Page) => page.locator(".am-summary__def");

async function pick(page: Page, name: RegExp) {
  await choice(page, name).check();
  await save(page).click();
}

test.beforeEach(async () => {
  await seed();
});
test.afterAll(async () => {
  await seed();
});

test("lists the three choices with a sentence each and the current one checked", async ({ page }) => {
  await signIn(page);
  await expect(card(page).getByRole("radio")).toHaveCount(3);
  await expect(choice(page, FOLLOW)).toBeChecked();
  await expect(card(page).getByText(/^Everyone in .+ can view/)).toBeVisible();
  await expect(choice(page, FOLLOW)).toHaveAccessibleDescription("Organization members can edit and organization viewers can view.");
  await expect(save(page)).toBeDisabled();
  await expect(label(page)).toHaveCount(0);
});

test("org role → restricted: the dry run's count and names, then Restricted", async ({ page }) => {
  await signIn(page);
  await pick(page, RESTRICTED);
  const d = page.getByRole("dialog", { name: "Restrict shop?" });
  await expect(d).toBeVisible();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
  // The fake's dry run counts Max, Vera and Sam; Lena keeps her direct Viewer grant but drops.
  await expect(d.locator('[data-impact="lose"]')).toHaveText("3 people lose access to shop: Max Member, Sam Okafor and Vera Viewer.");
  await expect(d.locator('[data-impact="drop"]')).toHaveText("1 person drops to Viewer: Lena Kovač.");
  await d.getByRole("button", { name: "Restrict project" }).click();
  await expect(d).toBeHidden();
  await expect(status(page)).toHaveText("This project is now restricted.");
  await expect(label(page)).toHaveText("Restricted");
  await expect(summary(page)).toHaveText("Default access: only organization owners and admins, and people added directly.");
  await expect(page.getByText(/^6 people have access/)).toBeVisible();

  await page.reload();
  await expect(choice(page, RESTRICTED)).toBeChecked();
  await expect(label(page)).toHaveText("Restricted");
});

test("org role → view only drops editors without taking access", async ({ page }) => {
  await signIn(page);
  await pick(page, VIEW);
  const d = page.getByRole("dialog", { name: "Change the default access of shop?" });
  await expect(d.locator('[data-impact="lose"]')).toHaveCount(0);
  await expect(d.locator('[data-impact="drop"]')).toHaveText("2 people drop to Viewer: Lena Kovač and Max Member.");
  await d.getByRole("button", { name: "Change default access" }).click();
  await expect(status(page)).toHaveText("Everyone in the organization can now view this project.");
  await expect(summary(page)).toHaveText("Default access: everyone in the organization can view.");
  await expect(label(page)).toHaveCount(0);
});

test("view only → restricted confirms; view only → org role saves at once", async ({ page }) => {
  await seed({ default_access: "viewer" });
  await signIn(page);
  await expect(choice(page, VIEW)).toBeChecked();

  await pick(page, RESTRICTED);
  const d = page.getByRole("dialog", { name: "Restrict shop?" });
  await expect(d.locator('[data-impact="lose"]')).toContainText("3 people lose access to shop");
  await d.getByRole("button", { name: "Restrict project" }).click();
  await expect(label(page)).toHaveText("Restricted");

  // Widening asks nothing.
  await pick(page, FOLLOW);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(status(page)).toHaveText("Default access now follows the organization role.");
  await expect(label(page)).toHaveCount(0);
  await expect(choice(page, FOLLOW)).toBeChecked();
});

test("restricted → view only and view only → org role widen without a dialog", async ({ page }) => {
  await seed({ default_access: "none" });
  await signIn(page);
  await expect(label(page)).toHaveText("Restricted");
  await pick(page, VIEW);
  await expect(status(page)).toHaveText("Everyone in the organization can now view this project.");
  await expect(label(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await expect(choice(page, VIEW)).toBeChecked();
  await pick(page, FOLLOW);
  await expect(summary(page)).toHaveText("Default access: organization members can edit and organization viewers can view.");
});

test("restricted → org role widens without a dialog", async ({ page }) => {
  await seed({ default_access: "none" });
  await signIn(page);
  await pick(page, FOLLOW);
  await expect(status(page)).toHaveText("Default access now follows the organization role.");
  await expect(page.getByText("9 people have access: 4 Admins, 3 Editors, 2 Viewers.")).toBeVisible();
});

test("cancel (button or Escape) leaves the setting unchanged", async ({ page }) => {
  await signIn(page);
  await pick(page, RESTRICTED);
  const d = page.getByRole("dialog", { name: "Restrict shop?" });
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
  await expect(choice(page, FOLLOW)).toBeChecked();
  await expect(status(page)).toHaveText("Cancelled. The default access is unchanged.");

  await pick(page, VIEW);
  await expect(page.getByRole("dialog", { name: "Change the default access of shop?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(choice(page, FOLLOW)).toBeChecked();

  await page.reload();
  await expect(choice(page, FOLLOW)).toBeChecked();
  await expect(label(page)).toHaveCount(0);
  await expect(page.getByText("9 people have access: 4 Admins, 3 Editors, 2 Viewers.")).toBeVisible();
});

test("names five people and counts the rest", async ({ page }) => {
  const members = Array.from({ length: 12 }, (_, i) => ({
    user_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Person ${String(i + 1).padStart(2, "0")}`,
    email: `person${String(i + 1).padStart(2, "0")}@example.com`,
    org_role: i === 0 ? "owner" : "member",
    direct_role: null,
    added_at: "2026-10-01T10:00:00Z",
    last_active_at: null,
  }));
  await seed({ members });
  await signIn(page);
  await pick(page, RESTRICTED);
  const d = page.getByRole("dialog", { name: "Restrict shop?" });
  await expect(d.locator('[data-impact="lose"]')).toHaveText("11 people lose access to shop: Person 02, Person 03, Person 04, Person 05, Person 06 and 6 more.");
});

test("a stale sign-in confirms who you are before the dry run", async ({ page }) => {
  await signIn(page, ADMIN, true);
  await pick(page, RESTRICTED);
  const r = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(r).toBeVisible();
  await r.getByRole("button", { name: "Email me a code" }).click();
  await r.getByRole("textbox", { name: "Code from the email we sent you" }).fill("123456");
  await r.getByRole("button", { name: "Confirm" }).click();
  await expect(r).toBeHidden();
  const d = page.getByRole("dialog", { name: "Restrict shop?" });
  await expect(d.locator('[data-impact="lose"]')).toContainText("3 people lose access");
  await d.getByRole("button", { name: "Restrict project" }).click();
  await expect(label(page)).toHaveText("Restricted");
});

test("a viewer sees the current setting read-only", async ({ page }) => {
  await seed({ default_access: "viewer" });
  await signIn(page, VIEWER);
  await expect(choice(page, VIEW)).toBeChecked();
  for (const r of await card(page).getByRole("radio").all()) await expect(r).toBeDisabled();
  await expect(card(page).getByText("Only project admins can change the default access.")).toBeVisible();
  await expect(save(page)).toHaveCount(0);
});

// Visual check (light/dark at 1440 and 390): `ACCESS_SHOTS=<dir> pnpm test:e2e:fake access-default`.
test("screenshots", async ({ page }) => {
  const dir = process.env.ACCESS_SHOTS;
  test.skip(!dir, "set ACCESS_SHOTS to a directory to capture screenshots");
  await seed({ default_access: "none" });
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto("/shop/access");
      await expect(card(page)).toBeVisible();
      await page.screenshot({ path: `${dir}/access-default-${theme}-${width}.png`, fullPage: true });
    }
  }
  await seed({ default_access: "org_role" });
  await page.goto("/shop/access");
  await pick(page, RESTRICTED);
  await expect(page.getByRole("dialog", { name: "Restrict shop?" })).toBeVisible();
  await page.screenshot({ path: `${dir}/access-default-confirm.png` });
});
