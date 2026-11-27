// "Last time you signed in as …" on /sign-in, against the fake identity: it names the method after
// a redirect-based sign-in, a fresh browser has no line, and the line never takes another method
// away. SSO drives the redirect here — it is the one the page still offers. A method recorded
// before Google and GitHub left the page still renders its own word, which the third test pins.
import { expect, test } from "@playwright/test";

const hint = (page: import("@playwright/test").Page) => page.getByTestId("last-signin");

test("after signing in with SSO, /sign-in names it; a fresh browser shows nothing", async ({ page, browser }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(hint(page)).toHaveCount(0);

  await page.getByLabel("Work email").fill("ada@acme.example.com");
  await page.getByRole("link", { name: "Continue with Acme SSO" }).click();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in" && !url.pathname.startsWith("/auth"));

  await page.waitForFunction(() => localStorage.getItem("apilens.last-signin") !== null);
  // Signed out again (the browser keeps its own storage, as after a real sign-out).
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await expect(hint(page)).toContainText("Last time you signed in as");
  await expect(hint(page)).toContainText("with single sign-on");
  await expect(hint(page)).toContainText("you@example.com");
  expect(await page.evaluate(() => localStorage.getItem("apilens.last-signin"))).toContain("you@example.com");
  // Ignoring it: the passkey button leads, and the email field and every provider are still there.
  await expect(page.getByRole("button", { name: "Continue with a passkey", exact: true })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with SSO", exact: true })).toBeVisible();

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto("/sign-in");
  await expect(other.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(hint(other)).toHaveCount(0);
  await fresh.close();
});

test("a sign-in that never completes records nothing", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("ada@acme.example.com");
  await page.getByRole("link", { name: "Continue with Acme SSO" }).click();
  await page.getByRole("link", { name: "Cancel" }).click();
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
