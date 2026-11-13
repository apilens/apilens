// Inviting someone new from Access › Members (#809) against the fake identity
// (e2e-fake/fake-identity.ts): an address that matches no org member offers "Invite to Acme and
// this project", the invitation shows up as pending under the members table and revoking removes
// it; refused addresses keep their chip with the reason next to them; without `members.invite`
// the option is disabled with the reason. Then the invitee's side: `inv_checkout` names Globex's
// Checkout project (as a Viewer) on the landing and accepting lands in Checkout. The fake's measured
// seed has two pending shop invitations (new.dev@ and contractor@example.com). No email is sent.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];
const INVITER = [...ADMIN, "members.invite"];
const EDITOR = ["project.read", "project.update", "api_keys.create", "api_keys.revoke"];

async function seed(body: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
}

async function signIn(page: Page, next: string, capabilities?: string[]) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...(capabilities ? { capabilities } : {}) }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const status = (page: Page) => page.locator(".am-status");
const pending = (page: Page) => page.getByRole("table", { name: "Pending invitations to shop" });
const pendingRow = (page: Page, email: string) => pending(page).locator("tbody tr").filter({ has: page.getByRole("rowheader", { name: email }) });

/** Opens "Add people", types `email` in the search and picks the invite option. */
async function startInvite(page: Page, email: string) {
  await page.getByRole("button", { name: "Add people" }).click();
  const d = page.getByRole("dialog", { name: "Add people to shop" });
  await d.getByRole("searchbox", { name: "Search organization members" }).fill(email);
  await expect(d.getByText(`Nobody in Acme matches “${email}”.`)).toBeVisible();
  await d.getByRole("button", { name: `Invite ${email} to Acme and this project` }).click();
  return page.getByRole("dialog", { name: "Invite to Acme and shop" });
}

test.beforeEach(async () => {
  await seed();
});
test.afterAll(async () => {
  await seed();
});

test("invites someone new: the pending row appears, revoking removes it", async ({ page }) => {
  await signIn(page, "/shop/access", INVITER);
  await expect(pendingRow(page, "new.dev@example.com")).toContainText("Editor");
  await expect(pendingRow(page, "new.dev@example.com").locator('td[data-label="Invited by"]')).toHaveText("Ada Admin");

  const d = await startInvite(page, "new.person@example.com");
  await expect(d.getByRole("list", { name: "Addresses to invite" })).toContainText("new.person@example.com");
  await expect(d.getByRole("combobox", { name: "Organization role" })).toHaveValue("member");
  await d.getByRole("radio", { name: /Editor/ }).check();
  await d.getByRole("button", { name: "Send invitation" }).click();
  await expect(d).toBeHidden();
  await expect(status(page)).toHaveText("Invited new.person@example.com to Acme. They become an Editor on shop once they accept.");

  const row = pendingRow(page, "new.person@example.com");
  await expect(row.locator('td[data-label="Role on shop"]')).toHaveText("Editor");
  await expect(row.locator('td[data-label="Organization role"]')).toHaveText("Member");
  await expect(row.locator('td[data-label="Invited by"]')).toHaveText("Fake User");
  // Just sent: resending waits out the 5-minute cooldown.
  await expect(row.getByRole("button", { name: /Resend invitation to new.person@example.com in 4:5\d/ })).toBeDisabled();

  await row.getByRole("button", { name: "Revoke invitation to new.person@example.com" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke invitation?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(confirm).toBeHidden();
  await expect(status(page)).toHaveText("Invitation to new.person@example.com revoked.");
  await expect(pendingRow(page, "new.person@example.com")).toHaveCount(0);
  await expect(pending(page).locator("tbody tr")).toHaveCount(2);
});

test("resends a pending invitation from the list", async ({ page }) => {
  await signIn(page, "/shop/access", INVITER);
  const row = pendingRow(page, "new.dev@example.com");
  await row.getByRole("button", { name: "Resend invitation to new.dev@example.com" }).click();
  await expect(status(page)).toHaveText("Invitation resent to new.dev@example.com.");
  await expect(row.getByRole("button", { name: /Resend invitation to new.dev@example.com in 4:5\d/ })).toBeDisabled();
});

test("shows each refused address's reason next to it and sends the rest", async ({ page }) => {
  await signIn(page, "/shop/access", INVITER);
  const d = await startInvite(page, "fresh@example.com");
  const emails = d.getByRole("textbox", { name: /Email addresses/ });
  await emails.fill("ada@example.com");
  await emails.press("Enter");
  await d.getByRole("combobox", { name: "Organization role" }).selectOption("viewer");
  await d.getByRole("button", { name: "Send 2 invitations" }).click();

  // Ada is already in Acme: her chip stays with the reason, tied to the address.
  await expect(d.getByRole("alert")).toHaveText("Some addresses weren’t invited. Each one says why.");
  const chips = d.getByRole("list", { name: "Addresses to invite" }).getByRole("listitem");
  await expect(chips).toHaveCount(1);
  await expect(chips.getByText("ada@example.com")).toHaveAccessibleDescription("already in Acme, add them from the list");
  await expect(status(page)).toHaveText("Invited fresh@example.com to Acme. They become a Viewer on shop once they accept.");
  await expect(pendingRow(page, "fresh@example.com").locator('td[data-label="Organization role"]')).toHaveText("Viewer");

  // Removing the refused chip leaves nothing to send.
  await chips.getByRole("button", { name: "Remove ada@example.com" }).click();
  await expect(d.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  await d.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Add people to shop" })).toBeVisible();
});

test("without members.invite the option is disabled with the reason", async ({ page }) => {
  await signIn(page, "/shop/access", ADMIN);
  await page.getByRole("button", { name: "Add people" }).click();
  const d = page.getByRole("dialog", { name: "Add people to shop" });
  await d.getByRole("searchbox", { name: "Search organization members" }).fill("new.person@example.com");
  const invite = d.getByRole("button", { name: "Invite new.person@example.com to Acme and this project" });
  await expect(invite).toBeDisabled();
  await expect(invite).toHaveAccessibleDescription("Only organization owners and admins can invite new people to Acme.");
  await page.keyboard.press("Escape");

  // The pending list still shows; resending and revoking say why they can't be used.
  const revoke = pendingRow(page, "new.dev@example.com").getByRole("button", { name: "Revoke invitation to new.dev@example.com" });
  await expect(revoke).toBeDisabled();
  await expect(revoke).toHaveAccessibleDescription("Only organization owners and admins can resend or revoke invitations.");
});

test("an editor doesn't see pending invitations", async ({ page }) => {
  await signIn(page, "/shop/access", EDITOR);
  await expect(page.getByRole("table", { name: "People with access to shop" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending invitations" })).toHaveCount(0);
});

test("the invitation names the project, and accepting lands there as a Viewer", async ({ page }) => {
  await signIn(page, "/invite/inv_checkout");
  await expect(page.getByText("Olive Owner invited you to join Globex as a Member and Checkout as a Viewer.")).toBeVisible();
  await expect(page.getByTestId("invite-project")).toContainText(["Checkout", "Project · Viewer"].join(""));
  await page.getByRole("button", { name: "Accept invitation" }).click();

  // Still onboarding: the about step, then straight into Checkout (not Globex's first project).
  await page.waitForURL((url) => url.pathname === "/onboarding/about");
  await page.getByRole("button", { name: "Continue to Globex" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/checkout/"));

  // Not an admin of Checkout: its activity log is not theirs.
  await page.goto("/checkout/access/activity");
  await expect(page.getByRole("heading", { name: "You can’t see this project’s activity log" })).toBeVisible();
});
