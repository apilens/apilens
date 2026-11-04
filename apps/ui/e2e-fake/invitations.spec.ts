// Organization settings → Invitations (#346) against the fake identity (e2e-fake/fake-identity.ts).
// Each fake sign-in gets its own acme organization with three pending @example.com invitations:
// new.hire (sent a minute ago, so in its 5-minute resend cooldown), grace (sent two days ago by
// Ada Admin) and late (sent eight days ago, its link expired). Nothing sends mail.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PAGE = "/orgs/acme/settings/invitations";

async function signIn(page: Page, role: "owner" | "admin" | "member" | "viewer") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE, role }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
}

const rows = (page: Page) => page.getByRole("table").locator("tbody tr");
const row = (page: Page, email: string) => rows(page).filter({ has: page.getByRole("rowheader", { name: email }) });
const status = (page: Page) => page.locator(".om-status");

test.describe("as an admin", () => {
  test("lists pending invitations with role, inviter and expiry", async ({ page }) => {
    await signIn(page, "admin");
    await expect(page.getByText("3 pending invitations")).toBeVisible();
    await expect(rows(page).locator("th")).toHaveText(["new.hire@example.com", "grace@example.com", "late@example.com"]);
    await expect(row(page, "grace@example.com").locator("td")).toContainText(["Admin", "Ada Admin"]);
    await expect(row(page, "new.hire@example.com").locator("td").nth(1)).toHaveText("Fake User");
    await expect(row(page, "late@example.com").locator("td").nth(1)).toHaveText("—");
    await expect(row(page, "late@example.com").getByText(/^Expired/)).toBeVisible();

    const tabs = page.getByRole("navigation", { name: "Organization settings" });
    await expect(tabs.getByRole("link", { name: "Invitations" })).toHaveAttribute("aria-current", "page");
  });

  test("shows the resend cooldown and resends", async ({ page }) => {
    await signIn(page, "admin");
    // Sent a minute ago: the button counts down and says why.
    const cooling = page.getByRole("button", { name: /^Resend invitation to new\.hire@example\.com in [0-4]:\d\d$/ });
    await expect(cooling).toBeDisabled();
    await expect(cooling).toHaveText(/^Resend in [0-4]:\d\d$/);
    await expect(cooling).toHaveAccessibleDescription("An invitation can be emailed once every 5 minutes.");

    // An expired invitation can still be resent; afterwards its own cooldown starts.
    await page.getByRole("button", { name: "Resend invitation to late@example.com" }).click();
    await expect(status(page)).toHaveText("Invitation resent to late@example.com.");
    await expect(row(page, "late@example.com").getByText(/^Expired/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Resend invitation to late@example\.com in [45]:\d\d$/ })).toBeDisabled();
  });

  test("revokes an invitation after confirming", async ({ page }) => {
    await signIn(page, "admin");
    await page.getByRole("button", { name: "Revoke invitation to grace@example.com" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke invitation?" });
    await expect(dialog).toContainText("grace@example.com");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(page)).toHaveCount(3);

    await page.getByRole("button", { name: "Revoke invitation to grace@example.com" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
    await expect(status(page)).toHaveText("Invitation to grace@example.com revoked.");
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByText("2 pending invitations")).toBeVisible();
  });

  test("invites with the shared chip input, one role per address", async ({ page }) => {
    await signIn(page, "admin");
    await page.getByRole("button", { name: "Invite people" }).click();
    const dialog = page.getByRole("dialog", { name: "Invite people to Acme" });
    const emails = dialog.getByLabel("Email addresses");
    await emails.fill("Lin@Example.com");
    await emails.press("Enter");
    await emails.fill("kai@example.com");
    await emails.press(",");
    await dialog.getByLabel("Role for kai@example.com").selectOption("viewer");
    await emails.press("Backspace");
    await expect(dialog.getByRole("listitem")).toHaveText([/lin@example\.com/]);
    await emails.fill("kai@example.com");
    await dialog.getByLabel("Default role").selectOption("admin");
    await dialog.getByRole("button", { name: "Send 2 invitations" }).click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText("Sent 2 invitations.");
    await expect(rows(page)).toHaveCount(5);
    await expect(row(page, "lin@example.com").locator("td").first()).toHaveText("Member");
    await expect(row(page, "kai@example.com").locator("td").first()).toHaveText("Admin");
  });
});

test("as a member the list is hidden and inviting is disabled with its reason", async ({ page }) => {
  await signIn(page, "member");
  await expect(page.getByText("Only owners and admins can see invitations")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  const invite = page.getByRole("button", { name: "Invite people" });
  await expect(invite).toBeDisabled();
  await expect(invite).toHaveAccessibleDescription("Only owners and admins can invite people.");
});

test("an empty list says so", async ({ page }) => {
  await signIn(page, "owner");
  for (const email of ["new.hire@example.com", "grace@example.com", "late@example.com"]) {
    await page.getByRole("button", { name: `Revoke invitation to ${email}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
    await expect(status(page)).toHaveText(`Invitation to ${email} revoked.`);
  }
  await expect(page.getByText("No pending invitations")).toBeVisible();
});

// Visual check (light/dark at 1440 and 390): `INVITATIONS_SHOTS=<dir> pnpm test:e2e:fake invitations`.
test("screenshots", async ({ page }) => {
  const dir = process.env.INVITATIONS_SHOTS;
  test.skip(!dir, "set INVITATIONS_SHOTS to a directory to capture screenshots");
  for (const role of ["admin", "member"] as const) {
    await signIn(page, role);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
        await page.screenshot({ path: `${dir}/invitations-${role}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  await signIn(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Invite people" }).click();
  const emails = page.getByLabel("Email addresses");
  await emails.fill("lin@example.com, kai@example.com, oops");
  await emails.press("Enter");
  await page.getByLabel("Role for kai@example.com").selectOption("admin");
  await page.screenshot({ path: `${dir}/invitations-invite-dialog.png` });
});
