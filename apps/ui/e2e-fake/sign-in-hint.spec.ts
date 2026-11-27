// "Last time you signed in as …" on /sign-in, against the fake identity: it names GitHub after a
// GitHub sign-in, a fresh browser has no line, and the line never takes another method away.
import { expect, test } from "@playwright/test";

const hint = (page: import("@playwright/test").Page) => page.getByTestId("last-signin");

test("after signing in with GitHub, /sign-in names GitHub; a fresh browser shows nothing", async ({ page, browser }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(hint(page)).toHaveCount(0);

  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in" && !url.pathname.startsWith("/auth"));

  await page.waitForFunction(() => localStorage.getItem("apilens.last-signin") !== null);
  // Signed out again (the browser keeps its own storage, as after a real sign-out).
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await expect(hint(page)).toContainText("Last time you signed in as");
  await expect(hint(page)).toContainText("with GitHub");
  await expect(hint(page)).toContainText("you@example.com");
  expect(await page.evaluate(() => localStorage.getItem("apilens.last-signin"))).toContain("you@example.com");
  // Ignoring it: the passkey button leads, and the email field and every provider are still there.
  await expect(page.getByRole("button", { name: "Passkey" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.locator("a.ah-btn").filter({ hasText: /^Google$/ })).toBeVisible();

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto("/sign-in");
  await expect(other.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(hint(other)).toHaveCount(0);
  await fresh.close();
});

test("a sign-in that never completes records nothing", async ({ page }) => {
  await page.goto("/sign-in");
  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Deny" }).click();
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(hint(page)).toHaveCount(0);
});

test("Not you? on the line clears it for good", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("apilens.last-signin")) localStorage.setItem("apilens.last-signin", JSON.stringify({ method: "google", email: "ada@acme.dev" }));
  });
  await page.goto("/sign-in");
  await expect(hint(page)).toContainText("ada@acme.dev");
  await expect(hint(page)).toContainText("with Google");
  await hint(page).getByRole("button", { name: "Not you?" }).click();
  await expect(hint(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("apilens.last-signin"))).toBeNull();
});

test("the address is stated once: the remembered row wins over the line", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("apilens.last-signin", JSON.stringify({ method: "email", email: "ada@acme.dev" }));
    localStorage.setItem("apilens.remembered-account", JSON.stringify({ email: "ada@acme.dev", at: Date.now(), method: "email" }));
  });
  await page.goto("/sign-in");
  await expect(page.getByText("Used on this device")).toBeVisible();
  await expect(hint(page)).toHaveCount(0);
});
