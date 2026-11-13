// Changing access on Access › Members (#807) against the fake identity (e2e-fake/fake-identity.ts):
// add two people, change a role, remove one (each reported in the status line, and the removal
// says what the person keeps first), org owners and admins locked, editors and viewers seeing
// the controls disabled with the reason, the whole add flow by keyboard, and a stale sign-in
// confirming before the change. The fake's measured seed is nine acme people under the `org_role`
// default (the context names the project "shop"); acme's org members are you (owner), Ada (admin), Max (member) and Vera (viewer).
// The reauth code is the fake's fixed 123456: no email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const EDITOR = ["project.read", "project.update", "api_keys.create", "api_keys.revoke"];
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

const table = (page: Page) => page.getByRole("table", { name: "People with access to shop" });
const row = (page: Page, name: string) => table(page).locator("tbody tr").filter({ has: page.getByRole("rowheader", { name: new RegExp(name) }) });
const status = (page: Page) => page.locator(".am-status");
const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add people to shop" });

test.beforeEach(async () => {
  await seed();
});
test.afterAll(async () => {
  await seed();
});

test("adds two people, changes a role and removes one, each in the status line", async ({ page }) => {
  await signIn(page);

  // Add: only org members without a direct role are offered, never org owners or admins.
  await page.getByRole("button", { name: "Add people" }).click();
  const d = addDialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole("checkbox")).toHaveCount(2);
  await expect(d.getByRole("group", { name: /Role/ })).toContainText(["Manages access, the activity log and the danger zone."]);
  await d.getByRole("button", { name: "Add person" }).click();
  await expect(d.getByRole("alert")).toHaveText("Choose at least one person.");
  await d.getByRole("checkbox", { name: /Max Member/ }).check();
  await d.getByRole("checkbox", { name: /Vera Viewer/ }).check();
  await d.getByRole("radio", { name: /Admin/ }).check();
  await d.getByRole("button", { name: "Add 2 people" }).click();
  await expect(d).toBeHidden();
  await expect(status(page)).toHaveText("Added Max Member and Vera Viewer to shop as Admins.");
  await expect(row(page, "Max Member").locator('td[data-label="Role"]')).toHaveText("Admin");
  await expect(row(page, "Vera Viewer").locator('td[data-label="Source"] li')).toContainText(["Organization viewer (project default) · Viewer", "Added to this project · Admin"]);

  // Change a role from the row menu.
  await row(page, "Tom Becker").getByRole("button", { name: "Change access for Tom Becker" }).click();
  await page.getByRole("menuitem", { name: "Change role" }).click();
  const edit = page.getByRole("dialog", { name: "Change Tom Becker’s role" });
  await expect(edit.getByRole("radio", { name: /Editor/ })).toBeChecked();
  await edit.getByRole("radio", { name: /Admin/ }).check();
  await edit.getByRole("button", { name: "Save role" }).click();
  await expect(edit).toBeHidden();
  await expect(status(page)).toHaveText("Tom Becker is now an Admin on shop.");
  await expect(row(page, "Tom Becker").locator('td[data-label="Role"]')).toHaveText("Admin");

  // Remove: the dialog says what the person keeps before confirming, with focus on Cancel.
  await row(page, "Lena Kovač").getByRole("button", { name: "Change access for Lena Kovač" }).click();
  await page.getByRole("menuitem", { name: "Remove from project" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Lena Kovač from shop?" });
  await expect(confirm).toContainText("Lena Kovač stays an Editor through the project default.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove from project" }).click();
  await expect(confirm).toBeHidden();
  await expect(status(page)).toHaveText("Removed Lena Kovač from shop. Lena Kovač stays an Editor through the project default.");
  await expect(row(page, "Lena Kovač").locator('td[data-label="Source"] li')).toHaveText(["Organization member (project default)"]);
});

test("org owners and admins show a locked role with the reason", async ({ page }) => {
  await signIn(page);
  const locked = row(page, "Olive Owner").getByRole("button", { name: "Role of Olive Owner is locked" });
  await expect(locked).toBeDisabled();
  await expect(locked).toHaveAccessibleDescription("Organization owners and admins are Admin on every project.");
  // Someone with only the project default has nothing to remove.
  await row(page, "Max Member").getByRole("button", { name: "Change access for Max Member" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from project" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
});

for (const [who, capabilities] of [
  ["an editor", EDITOR],
  ["a viewer", VIEWER],
] as const) {
  test(`${who} sees the controls disabled with the reason`, async ({ page }) => {
    await signIn(page, [...capabilities]);
    const add = page.getByRole("button", { name: "Add people" });
    await expect(add).toBeDisabled();
    await expect(add).toHaveAccessibleDescription("Only project admins can add people.");
    const menu = row(page, "Tom Becker").getByRole("button", { name: "Change access for Tom Becker" });
    await expect(menu).toBeDisabled();
    await expect(menu).toHaveAccessibleDescription("Only project admins can change access.");
  });
}

test("keyboard only: open the dialog, select, save, focus returns to the button", async ({ page }) => {
  await signIn(page);
  const add = page.getByRole("button", { name: "Add people" });
  await add.focus();
  await page.keyboard.press("Enter");
  const d = addDialog(page);
  await expect(d.getByRole("searchbox", { name: "Search organization members" })).toBeFocused();
  await page.keyboard.type("max");
  await expect(d.getByRole("checkbox")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(d.getByRole("checkbox", { name: /Max Member/ })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(d.getByRole("radio", { name: /Viewer/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(d.getByRole("radio", { name: /Editor/ })).toBeChecked();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(d.getByRole("button", { name: "Add person" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(d).toBeHidden();
  await expect(status(page)).toHaveText("Added Max Member to shop as Editor.");
  await expect(add).toBeFocused();

  // Escape closes it without a change, and focus comes back too.
  await page.keyboard.press("Enter");
  await expect(d).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  await expect(add).toBeFocused();
});

test("a stale sign-in confirms who they are, then the change goes through", async ({ page }) => {
  await signIn(page, ADMIN, true);
  await page.getByRole("button", { name: "Add people" }).click();
  const d = addDialog(page);
  await d.getByRole("checkbox", { name: /Vera Viewer/ }).check();
  await d.getByRole("button", { name: "Add person" }).click();

  const reauth = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(reauth).toBeVisible();
  await reauth.getByRole("button", { name: "Email me a code" }).click();
  await reauth.getByRole("textbox", { name: "Code from the email we sent you" }).fill("123456");
  await reauth.getByRole("button", { name: "Confirm" }).click();
  await expect(reauth).toBeHidden();
  await expect(d).toBeHidden();
  await expect(status(page)).toHaveText("Added Vera Viewer to shop as Viewer.");
});
