// Organization settings → Members (#345) against the fake identity (e2e-fake/fake-identity.ts).
// Each fake sign-in gets its own acme organization: the signed-in "Fake User" with the role the
// test asks for, plus Olive Owner (unless the user is the owner), Ada Admin, Max Member and Vera
// Viewer, all @example.com. Capabilities in the context follow the role, as SpiceDB answers them.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const PAGE = "/orgs/acme/settings/members";

async function signIn(page: Page, role: "owner" | "admin" | "member" | "viewer") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: PAGE, role }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
}

const rows = (page: Page) => page.getByRole("table").locator("tbody tr");
const roleOf = (page: Page, name: string) => page.getByRole("combobox", { name: `Role of ${name}` });
const removeButton = (page: Page, name: string) => page.getByRole("button", { name: `Remove ${name}` });
const status = (page: Page) => page.locator(".om-status");

test.describe("as an admin", () => {
  test("lists members and gates owner rows", async ({ page }) => {
    await signIn(page, "admin");
    await expect(rows(page).locator("th")).toHaveText([/Olive Owner/, /Fake User\s*You/, /Ada Admin/, /Max Member/, /Vera Viewer/]);
    await expect(rows(page).nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.getByText("5 members")).toBeVisible();

    await expect(roleOf(page, "Olive Owner")).toBeDisabled();
    await expect(roleOf(page, "Olive Owner")).toHaveAccessibleDescription("Only owners can change an owner’s role.");
    await expect(removeButton(page, "Olive Owner")).toHaveAccessibleDescription("Only owners can remove an owner.");
    await expect(roleOf(page, "Fake User")).toHaveAccessibleDescription("You can’t change your own role.");
    await expect(roleOf(page, "Max Member")).toBeEnabled();
    // Only owners make owners.
    await expect(roleOf(page, "Max Member").locator("option", { hasText: "Owner" })).toBeDisabled();

    const transfer = page.getByRole("button", { name: "Transfer ownership" });
    await expect(transfer).toBeDisabled();
    await expect(transfer).toHaveAccessibleDescription("Only owners can transfer ownership.");
    // The reason shows on hover.
    await transfer.locator("..").hover();
    await expect(page.getByRole("tooltip", { name: "Only owners can transfer ownership." })).toBeVisible();
  });

  test("changes a role", async ({ page }) => {
    await signIn(page, "admin");
    await roleOf(page, "Max Member").selectOption("viewer");
    await expect(status(page)).toHaveText("Max Member is now a viewer.");
    await page.reload();
    await expect(roleOf(page, "Max Member")).toHaveValue("viewer");
  });

  test("removes a member after confirming", async ({ page }) => {
    await signIn(page, "admin");
    await removeButton(page, "Vera Viewer").click();
    const dialog = page.getByRole("dialog", { name: "Remove Vera Viewer?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(page)).toHaveCount(5);

    await removeButton(page, "Vera Viewer").click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
    await expect(status(page)).toHaveText("Vera Viewer was removed.");
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByRole("table").getByText("Vera Viewer")).toHaveCount(0);
  });

  test("invites people from the dialog", async ({ page }) => {
    await signIn(page, "admin");
    await page.getByRole("button", { name: "Invite people" }).click();
    const dialog = page.getByRole("dialog", { name: "Invite people to Acme" });
    const emails = dialog.getByLabel("Email addresses");
    await emails.fill("new@example.com, not-an-address");
    await dialog.getByRole("button", { name: "Send invitation" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("“not-an-address” isn’t an email address.");

    await emails.fill("new@example.com\nmax@example.com");
    await dialog.getByLabel("Role").selectOption("viewer");
    await dialog.getByRole("button", { name: "Send 2 invitations" }).click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText("Sent 1 invitation. max@example.com is already a member.");
  });
});

test("as a viewer every control is disabled with its reason", async ({ page }) => {
  await signIn(page, "viewer");
  for (const name of ["Olive Owner", "Ada Admin", "Max Member"]) {
    await expect(roleOf(page, name)).toBeDisabled();
    await expect(roleOf(page, name)).toHaveAccessibleDescription("Only owners and admins can change roles.");
    await expect(removeButton(page, name)).toBeDisabled();
    await expect(removeButton(page, name)).toHaveAccessibleDescription("Only owners and admins can remove members.");
  }
  const invite = page.getByRole("button", { name: "Invite people" });
  await expect(invite).toBeDisabled();
  await expect(invite).toHaveAccessibleDescription("Only owners and admins can invite people.");
  await expect(page.getByRole("button", { name: "Transfer ownership" })).toBeDisabled();
  // Keyboard users reach the reason too.
  await invite.locator("..").focus();
  await expect(page.getByRole("tooltip", { name: "Only owners and admins can invite people." })).toBeVisible();
});

test("as the only owner, transfers ownership and becomes an admin", async ({ page }) => {
  await signIn(page, "owner");
  await expect(roleOf(page, "Fake User")).toBeDisabled();
  await expect(removeButton(page, "Fake User")).toHaveAccessibleDescription("You can’t remove yourself.");
  await expect(roleOf(page, "Ada Admin").locator("option", { hasText: "Owner" })).toBeEnabled();

  await page.getByRole("button", { name: "Transfer ownership" }).click();
  const dialog = page.getByRole("dialog", { name: "Transfer ownership" });
  const submit = dialog.getByRole("button", { name: "Transfer ownership" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("New owner").selectOption({ label: "Ada Admin · Admin" });
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText("Ada Admin is now an owner. You’re an admin.");
  await expect(roleOf(page, "Ada Admin")).toHaveValue("owner");
  await expect(roleOf(page, "Fake User")).toHaveValue("admin");
  // Now an admin: the new owner's row and the transfer are owner-only.
  await expect(roleOf(page, "Ada Admin")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Transfer ownership" })).toBeDisabled();
});

test("the section tabs link General and Members", async ({ page }) => {
  await signIn(page, "member");
  const tabs = page.getByRole("navigation", { name: "Organization settings" });
  await expect(tabs.getByRole("link")).toHaveText(["General", "Members"]);
  await expect(tabs.getByRole("link", { name: "General" })).toHaveAttribute("href", "/orgs/acme/settings");
  await expect(tabs.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
});

// Visual check (light/dark at 1440 and 390): `MEMBERS_SHOTS=<dir> pnpm test:e2e:fake members`.
test("screenshots", async ({ page }) => {
  const dir = process.env.MEMBERS_SHOTS;
  test.skip(!dir, "set MEMBERS_SHOTS to a directory to capture screenshots");
  for (const role of ["admin", "viewer"] as const) {
    await signIn(page, role);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
        await page.screenshot({ path: `${dir}/members-${role}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  await signIn(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByLabel("Email addresses").fill("new@example.com, grace@example.com");
  await page.screenshot({ path: `${dir}/members-invite-dialog.png` });
});
