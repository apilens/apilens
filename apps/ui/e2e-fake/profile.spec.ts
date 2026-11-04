// Profile and Danger zone (#340) against the fake identity (e2e-fake/fake-identity.ts): renaming,
// changing the email with a code, and deleting the account (refused while the only owner of an
// organization). No mail is sent: the fake accepts the code 123456.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";

// The fake keeps one profile; these tests change it, so they run one after another.
test.describe.configure({ mode: "serial" });

async function fakeProfile(state: { name?: string; email?: string; sole_owner?: boolean } = {}) {
  await fetch(`${IDENTITY}/__fake/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
}

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

test.beforeEach(() => fakeProfile());
test.afterAll(() => fakeProfile());

test("renames and shows the new initials", async ({ page }) => {
  await signIn(page, "/settings");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  const name = page.getByLabel("Full name");
  await expect(name).toHaveValue("Fake User");

  await name.fill("   ");
  await expect(page.getByText("Enter your name.")).toBeVisible();
  await expect(save).toBeDisabled();

  await name.fill("Grace Hopper");
  await expect(page.locator(".ac-avatar")).toHaveText("GH");
  await save.click();
  await expect(page.getByText("Name saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Account menu, Grace Hopper/ })).toBeVisible();
});

test("changes the email with a code", async ({ page }) => {
  await signIn(page, "/settings");
  await page.getByRole("button", { name: "Change email address you@example.com" }).click();
  const field = page.getByLabel("New email address");
  await expect(field).toBeFocused();

  await field.fill("taken@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.locator(".acct-main").getByRole("alert")).toHaveText(/already uses/);

  await field.fill("new@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("Enter the code we sent to new@example.com.")).toBeVisible();

  const code = page.getByLabel(/Enter the code/);
  await code.fill("000000");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".acct-main").getByRole("alert")).toHaveText(/isn’t right/);

  await code.fill("123 456");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Email changed. Your other devices were signed out.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change email address new@example.com" })).toBeVisible();
});

test("explains why the only owner of an organization can't delete the account", async ({ page }) => {
  await signIn(page, "/settings/danger");
  await page.getByRole("button", { name: "Delete account" }).click();
  const confirm = page.getByRole("button", { name: "Delete my account" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/To confirm, type/).fill("you@example.com");
  await confirm.click();
  const alert = page.locator(".acct-main").getByRole("alert");
  await expect(alert).toContainText("Your account wasn’t deleted.");
  await expect(alert.getByRole("link", { name: "Acme" })).toHaveAttribute("href", "/orgs/acme/settings");
});

test("deletes the account and lands signed out", async ({ page }) => {
  await fakeProfile({ sole_owner: false });
  await signIn(page, "/settings/danger");
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByLabel(/To confirm, type/).fill("YOU@example.com");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("reason") === "account_deleted");
  await expect(page.getByText(/scheduled for deletion and you’re signed out everywhere/)).toBeVisible();
  // The session cookie is gone: account pages send the browser back to sign-in.
  await page.goto("/settings");
  await page.waitForURL((url) => url.pathname === "/sign-in");
});

// Visual check (light/dark at 1440 and 390): `PROFILE_SHOTS=<dir> pnpm test:e2e:fake profile`.
test("screenshots", async ({ page }) => {
  const dir = process.env.PROFILE_SHOTS;
  test.skip(!dir, "set PROFILE_SHOTS to a directory to capture screenshots");
  await signIn(page, "/settings");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto("/settings");
      await page.getByRole("button", { name: /^Change email address/ }).click();
      await page.getByLabel("New email address").fill("new@example.com");
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByLabel(/Enter the code/)).toBeVisible();
      await page.screenshot({ path: `${dir}/profile-${theme}-${width}.png`, fullPage: true });
      await page.goto("/settings/danger");
      await page.getByRole("button", { name: "Delete account" }).click();
      await page.getByLabel(/To confirm, type/).fill("you@example.com");
      await page.getByRole("button", { name: "Delete my account" }).click();
      await expect(page.locator(".acct-main").getByRole("alert")).toBeVisible();
      await page.screenshot({ path: `${dir}/danger-${theme}-${width}.png`, fullPage: true });
    }
  }
});
