// Re-authentication (#803) against the fake identity (e2e-fake/fake-identity.ts): a stale sign-in
// that creates an API key gets `reauth_required`, which opens "Confirm it's you" instead of an
// error; a code confirms it and the key is created without pressing Create again. Cancelling
// leaves nothing changed. The emailed code is the fake's fixed 123456: no mail is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const KEYS = "/shop/settings/keys";
const MANAGE = ["project.read", "api_keys.create", "api_keys.revoke"];

async function signIn(page: Page) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: KEYS, capabilities: MANAGE, api_keys: [], stale: true }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === KEYS);
}

const card = (page: Page) => page.getByRole("region", { name: "API keys" });
const rows = (page: Page) => card(page).locator("tbody tr.pk-row");
const keyDialog = (page: Page) => page.getByRole("dialog", { name: "Create API key" });
const reauth = (page: Page) => page.getByRole("dialog", { name: "Confirm it’s you" });

async function startCreate(page: Page, name: string) {
  await card(page).getByRole("button", { name: "Create API key" }).click();
  await keyDialog(page).getByRole("textbox", { name: /Name/ }).fill(name);
  await keyDialog(page).getByRole("button", { name: "Create key" }).click();
}

test("a stale sign-in confirms with an emailed code and the key is created", async ({ page }) => {
  await signIn(page);
  await startCreate(page, "Production backend");

  const d = reauth(page);
  await expect(d).toBeVisible();
  await expect(d).toContainText("This change needs a recent sign-in.");
  await d.getByRole("button", { name: "Email me a code" }).click();
  await expect(d.getByRole("status").filter({ hasText: "We emailed you a code." })).toBeVisible();
  const field = d.getByRole("textbox", { name: "Code from the email we sent you" });
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");

  await field.fill("000000");
  await d.getByRole("button", { name: "Confirm" }).click();
  await expect(d.getByRole("alert")).toHaveText("That code isn’t right. Check it and try again.");
  await expect(field).toHaveAttribute("aria-describedby", /.+/);

  await field.fill("123456");
  await d.getByRole("button", { name: "Confirm" }).click();

  // The original action ran again on its own: the one-time reveal shows.
  await expect(d).toBeHidden();
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Production backend");

  // The session is fresh now: the next sensitive action does not ask again.
  await startCreate(page, "Second key");
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(reauth(page)).toBeHidden();
});

test("cancelling the dialog leaves nothing changed", async ({ page }) => {
  await signIn(page);
  await startCreate(page, "Never created");

  const d = reauth(page);
  await expect(d).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  // Back on the form as it was, with no error, and no key exists.
  await expect(keyDialog(page)).toBeVisible();
  await expect(keyDialog(page).getByRole("textbox", { name: /Name/ })).toHaveValue("Never created");
  await expect(keyDialog(page).getByRole("alert")).toHaveCount(0);
  await keyDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(card(page).getByRole("heading", { name: "No API keys yet" })).toBeVisible();

  // Cancel by button too: still nothing created.
  await startCreate(page, "Never created");
  await reauth(page).getByRole("button", { name: "Cancel" }).click();
  await expect(reauth(page)).toBeHidden();
  await expect(keyDialog(page).getByRole("button", { name: "Create key" })).toBeFocused();
  await page.reload();
  await expect(card(page).getByRole("heading", { name: "No API keys yet" })).toBeVisible();
});
