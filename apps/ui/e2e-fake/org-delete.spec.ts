// Organization settings → Danger zone (#347) through the shared confirmation dialog (#802), keyboard
// only, against the fake identity (e2e-fake/fake-identity.ts). Each sign-in seeds its own org to delete.
import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";

async function signIn(page: Page, path: string, orgs: { slug: string; name: string }[] = []) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: path, role: "owner", orgs }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === path);
}

test("an owner deletes an organization with the keyboard alone", async ({ page }) => {
  const slug = `gone-${randomUUID().slice(0, 8)}`;
  const path = `/orgs/${slug}/settings`;
  await signIn(page, path, [{ slug, name: "Gone Co" }]);

  const opener = page.getByRole("button", { name: "Delete organization" });
  const dialog = page.getByRole("dialog", { name: "Delete Gone Co?" });
  await opener.focus();

  // Opens with focus on Cancel; Escape cancels and focus returns to the opener.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/stop being available to every member/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Cancel with the keyboard also returns focus.
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // The action stays disabled until the slug is typed exactly (case matters).
  await page.keyboard.press("Enter");
  const field = dialog.getByLabel(`To confirm, type ${slug} below.`);
  const action = dialog.getByRole("button", { name: "Delete Gone Co" });
  await page.keyboard.press("Shift+Tab");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await page.keyboard.type(slug.toUpperCase());
  await expect(action).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(` ${slug} `);
  await expect(action).toBeEnabled();
  await page.keyboard.press("Enter");

  await page.waitForURL((url) => !url.pathname.startsWith(`/orgs/${slug}`));
});

test("a failed deletion keeps the dialog open with the reason", async ({ page }) => {
  // The fake refuses to delete the seeded acme organization.
  await signIn(page, "/orgs/acme/settings");
  await page.getByRole("button", { name: "Delete organization" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Acme?" });
  const field = dialog.getByLabel("To confirm, type acme below.");
  await field.fill("acme");
  await dialog.getByRole("button", { name: "Delete Acme" }).click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();
});
