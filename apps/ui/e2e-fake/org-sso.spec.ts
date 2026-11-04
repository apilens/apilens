// Organization settings → Single sign-on (#348) against the fake identity (e2e-fake/fake-identity.ts).
// Each fake sign-in gets its own acme organization and SSO connection (none unless seeded).
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PAGE = "/orgs/acme/settings/sso";

async function signIn(page: Page, role: "owner" | "admin" | "member" | "viewer", sso?: Record<string, unknown>) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE, role, sso }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("link", { name: "Single sign-on" })).toHaveAttribute("aria-current", "page");
}

const enforce = (page: Page) => page.getByRole("switch", { name: /Require SSO/ });

test("an admin sees why they can't manage SSO", async ({ page }) => {
  await signIn(page, "admin");
  await expect(page.getByText(/Only owners can set up or change single sign-on/)).toBeVisible();
  await expect(page.getByLabel("Issuer URL")).toHaveCount(0);
});

test("an owner sets up a connection, tests it and can't require it before signing in through it", async ({ page }) => {
  await signIn(page, "owner");
  await expect(page.getByText("Not set up")).toBeVisible();
  await expect(enforce(page)).toBeDisabled();
  await expect(enforce(page)).toHaveAccessibleDescription(/Save the connection first/);

  await page.getByLabel("Issuer URL").fill("https://broken.example.com");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator(".sso-test[role=alert]")).toContainText("Discovery failed");

  await page.getByLabel("Issuer URL").fill("https://idp.example.com");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Discovery succeeded for https://idp.example.com")).toBeVisible();
  await expect(page.getByText("https://idp.example.com/jwks")).toBeVisible();

  await page.getByLabel("Client ID").fill("apilens");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByText("Enter the client secret your identity provider issued.")).toBeVisible();
  await page.getByLabel("Client secret").fill("s3cret");
  await page.getByLabel("Email domains").fill("gmail.com");
  await page.getByLabel("Email domains").press("Enter");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.locator("#sso-domain-err")).toContainText("Public email domains");
  await page.getByRole("button", { name: "Remove gmail.com" }).click();
  await page.getByLabel("Email domains").fill("example.com");
  await page.getByLabel("Default role").selectOption("viewer");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.locator("#sso-conn-status")).toHaveText(/Connection saved/);
  await expect(page.getByText("Untested")).toBeVisible();
  await expect(page.locator(".val", { hasText: "/api/v1/auth/sso/acme/callback" })).toBeVisible();
  await expect(page.getByLabel("Client secret")).toHaveValue("");

  await expect(enforce(page)).toBeDisabled();
  await expect(enforce(page)).toHaveAccessibleDescription(/Sign in through this connection once/);
  await expect(page.getByRole("link", { name: "Sign in with SSO to test it" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Default role")).toHaveValue("viewer");
  await expect(page.locator(".os-chip", { hasText: "example.com" })).toBeVisible();
});

test("an owner requires SSO once it was used, and removes the connection", async ({ page }) => {
  await signIn(page, "owner", { last_login_at: "2026-11-01T10:00:00Z" });
  await expect(page.getByText(/Active · last sign-in/)).toBeVisible();
  await expect(enforce(page)).toBeEnabled();
  await enforce(page).click();
  await expect(enforce(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#sso-enforce-status")).toHaveText("SSO is now required.");
  await expect(page.getByText("Required", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove connection" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Not set up")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Not set up")).toBeVisible();
});

// Visual check (light/dark at 1440 and 390, tall enough for the whole page): `SSO_SHOTS=<dir> pnpm test:e2e:fake org-sso`.
test("screenshots", async ({ page }) => {
  const dir = process.env.SSO_SHOTS;
  test.skip(!dir, "set SSO_SHOTS to a directory to capture screenshots");
  const cases = [
    ["new", "owner", undefined],
    ["untested", "owner", {}],
    ["active", "owner", { last_login_at: "2026-11-01T10:00:00Z" }],
    ["admin", "admin", undefined],
  ] as const;
  for (const [name, role, sso] of cases) {
    await signIn(page, role, sso);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 1900 : 2400 });
        await page.reload();
        if (sso) {
          // Show what a test discovers.
          await page.getByRole("button", { name: "Test connection" }).click();
          await expect(page.locator(".sso-test")).toBeVisible();
        }
        await page.screenshot({ path: `${dir}/sso-${name}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
});
