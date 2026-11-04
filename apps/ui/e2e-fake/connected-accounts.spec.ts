// Settings → Connected accounts (#344) against the fake identity (e2e-fake/fake-identity.ts):
// lists the connected accounts, disconnects one after a confirm, connects one through the fake
// provider (intent=link) and shows the banner for an account taken by another user.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/settings/connected-accounts";

async function post(path: string, body: unknown) {
  const res = await fetch(`${IDENTITY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function signIn(page: Page, next: string) {
  const { code } = (await post("/__fake/handoff", { next })) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const provider = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name }) });

test.beforeEach(async () => {
  await post("/__fake/identities", {
    identities: [
      {
        id: "6f1c1a52-3c1e-4c3a-9b6b-0d1d2e3f4a5b",
        provider: "github",
        email: "you@example.com",
        name: "Fake User",
        username: "octo-you",
        avatar_url: "",
        created_at: "2026-03-04T10:00:00Z",
        last_login_at: "2026-03-05T10:00:00Z",
      },
    ],
  });
});

test("lists providers with the connected account, its email and date", async ({ page }) => {
  await signIn(page, PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Connected accounts" })).toBeVisible();
  const github = provider(page, "GitHub");
  await expect(github.getByText("@octo-you")).toBeVisible();
  await expect(github.getByText("you@example.com · Connected Mar 4, 2026 · last sign-in Mar 5, 2026")).toBeVisible();
  await expect(provider(page, "Google").getByText("Not connected")).toBeVisible();
  await expect(provider(page, "Google").getByRole("button", { name: "Connect Google" })).toBeVisible();
});

test("disconnects an account after a confirm", async ({ page }) => {
  await signIn(page, PAGE);
  const github = provider(page, "GitHub");
  await github.getByRole("button", { name: "Disconnect GitHub account @octo-you" }).click();
  const confirm = page.getByRole("group", { name: "Disconnect @octo-you" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();

  await github.getByRole("button", { name: "Disconnect GitHub account @octo-you" }).click();
  await confirm.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(github.getByText("Not connected")).toBeVisible();
  await page.reload();
  await expect(provider(page, "GitHub").getByRole("button", { name: "Connect GitHub" })).toBeVisible();
});

test("connects Google through the provider and comes back with a banner", async ({ page }) => {
  await signIn(page, PAGE);
  await provider(page, "Google").getByRole("button", { name: "Connect Google" }).click();
  await page.getByRole("link", { name: "Authorize", exact: true }).click();
  await page.waitForURL((url) => url.pathname === PAGE && url.searchParams.get("linked") === "google");
  await expect(page.getByRole("status").filter({ hasText: "Google account connected" })).toBeVisible();
  await expect(provider(page, "Google").getByText("you@example.com")).toBeVisible();

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Google account connected")).toBeHidden();
  expect(new URL(page.url()).search).toBe("");
});

test("an account linked to another user shows the oauth_identity_taken banner here", async ({ page }) => {
  await post("/__fake/identities", { identities: [] });
  await signIn(page, PAGE);
  await provider(page, "GitHub").getByRole("button", { name: "Connect GitHub" }).click();
  await page.getByRole("link", { name: "Use a taken account" }).click();
  await page.waitForURL((url) => url.pathname === PAGE && url.searchParams.get("error") === "oauth_identity_taken");
  await expect(page.getByRole("alert").filter({ hasText: "already connected to a different APILens account" })).toBeVisible();
  await expect(provider(page, "GitHub").getByText("Not connected")).toBeVisible();
});
