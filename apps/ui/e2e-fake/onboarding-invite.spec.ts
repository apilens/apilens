// "Invite your team" (#336) against the fake identity: the chip input splits what is typed or
// pasted into one chip per address (invalid ones red, nothing sent while one is left), the
// Member/Viewer toggle sets the role of addresses added next and a chip's select changes one
// person's role (Admin included). "Send N invitations" posts them to the organization created in
// onboarding and lists the result per address; "Open project" or "Skip for now" finishes
// onboarding on the project. Every address is @example.com; the fake never sends mail.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** The fake identity, which serves the edge's `/v1/requests` too (playwright.fake.config.ts). */
const FAKE_EDGE = "http://127.0.0.1:18080";

/** Signs a new fake user in and walks onboarding to the waiting step; returns the ingest key it showed. */
async function toWaitingStep(page: Page, org: string, project: string): Promise<string> {
  await page.goto("/sign-in");
  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill(org);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await page.getByLabel("Name", { exact: true }).fill(project);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
  await page.getByRole("radio", { name: "Python", exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: /^APILens SDK/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  const key = page.getByRole("textbox", { name: "Ingest key" });
  await expect(key).toHaveValue(/^apl_live_[\w-]+$/);
  const raw = await key.inputValue();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/waiting");
  return raw;
}

/** Walks onboarding to the invite step the way a user does: first request in, then "Invite your team". */
async function toInviteViaFirstData(page: Page, org: string, project: string, appId: string) {
  const key = await toWaitingStep(page, org, project);
  const res = await fetch(`${FAKE_EDGE}/v1/requests`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ app_id: appId, timestamp: Math.floor(Date.now() / 1000), method: "GET", path: "/health", status_code: 200, response_time_ms: 12 }],
    }),
  });
  expect(await res.json()).toEqual({ accepted: 1 });
  await page.waitForURL((url) => url.pathname === "/onboarding/first-data", { timeout: 20_000 });
  await page.getByRole("button", { name: "Invite your team" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/invite");
  await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
}

/** The waiting step already reached the last stage, so the invite step may be opened directly. */
async function toInvite(page: Page, org: string, project: string) {
  await toWaitingStep(page, org, project);
  await page.goto("/onboarding/invite");
  await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
}

const emails = (page: Page) => page.getByLabel("Email addresses");
const chips = (page: Page) => page.getByRole("list", { name: "Addresses to invite" }).getByRole("listitem");

test("invite: chips per address with a role each, invalid ones blocked, per-address results, then the project", async ({ page }) => {
  test.setTimeout(90_000);
  await toInviteViaFirstData(page, "Hooli", "Hooli Search", "hooli-search");

  // Commas, spaces and new lines all split; an entry that is not an address becomes a red chip.
  await emails(page).fill("ada@example.com, grace@example.com bad-address");
  await emails(page).press("Enter");
  await expect(chips(page)).toHaveCount(3);
  await expect(chips(page).nth(2)).toContainText("not an email");
  const send = page.getByRole("button", { name: /^Send \d+ invitations?$/ });
  await expect(send).toHaveText("Send 2 invitations");
  await send.click();
  await expect(page.locator("#it-err")).toContainText("“bad-address” isn’t an email address.");
  await page.getByRole("button", { name: "Remove bad-address" }).click();
  await expect(page.locator("#it-err")).toHaveCount(0);

  // Admin is picked on the chip; the toggle sets the role of addresses added next.
  await expect(page.getByLabel("Role for ada@example.com")).toHaveValue("member");
  await page.getByLabel("Role for grace@example.com").selectOption("admin");
  await page.getByRole("radio", { name: "Viewer" }).check();
  await emails(page).fill("vera@example.com");
  await emails(page).press("Enter");
  await expect(page.getByLabel("Role for vera@example.com")).toHaveValue("viewer");
  // The signed-in user is already a member of the organization they created; typed, not chipped yet.
  await emails(page).fill("you@example.com");
  await expect(send).toHaveText("Send 4 invitations");
  await send.click();

  await expect(page.getByRole("heading", { name: "3 invitations sent", exact: true })).toBeVisible();
  const results = page.getByRole("list", { name: "3 invitations sent", exact: true }).getByRole("listitem");
  await expect(results).toHaveCount(4);
  await expect(results.nth(0)).toContainText("ada@example.com");
  await expect(results.nth(0)).toContainText("Invitation sent");
  await expect(results.nth(1)).toContainText("grace@example.com");
  await expect(results.nth(1)).toContainText("Invitation sent");
  await expect(results.nth(2)).toContainText("vera@example.com");
  await expect(results.nth(3)).toContainText("you@example.com");
  await expect(results.nth(3)).toContainText("Already a member");
  await expect(page.locator(".ob-bp")).toContainText("3 invited");

  // Inviting the same address again replaces its pending invitation.
  await page.getByRole("button", { name: "Invite more" }).click();
  // The count is saved with onboarding: a refresh keeps it.
  await page.reload();
  await expect(page.locator(".ob-bp")).toContainText("3 invited");
  await emails(page).fill("ada@example.com");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("heading", { name: "1 invitation sent", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem")).toContainText("New invitation sent");

  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForURL((url) => url.pathname === "/hooli-search/incidents");
  // Onboarding is finished: its pages now send the user to a project.
  await page.goto("/onboarding/invite");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
});

test("invite: skip for now finishes onboarding on the project", async ({ page }) => {
  test.setTimeout(60_000);
  await toInvite(page, "Raviga", "Raviga Capital");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL((url) => url.pathname === "/raviga-capital/incidents");
});

test("invite: a failed send keeps the addresses and says why", async ({ page }) => {
  test.setTimeout(60_000);
  await toInvite(page, "Bachmanity", "Bachmanity Insanity");
  await emails(page).fill("down@example.com");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.locator("#it-err")).toContainText("We couldn’t reach APILens.");
  await expect(chips(page)).toHaveCount(1);
  await expect(page).toHaveURL(/\/onboarding\/invite$/);
});

// #336: visual check in light and dark at 1440 and 390 px, axe finding no serious or critical
// violations and no sideways scroll, on the form (with an invalid chip) and on the results.
// Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding-invite`.
test("invite passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(150_000);
  await toInvite(page, "Endframe", "Endframe Video");
  const check = async (name: string, theme: string) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad, `${name} ${theme} at ${width} px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shots = process.env.AUTH_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/onboarding-invite-${name}-${theme}-${width}.png`, fullPage: true });
    }
  };
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.reload();
    await emails(page).fill("ada@example.com grace@example.com nope");
    await emails(page).press("Enter");
    await expect(chips(page)).toHaveCount(3);
    await page.getByLabel("Role for grace@example.com").selectOption("admin");
    await check("form", theme);
    await page.getByRole("button", { name: "Remove nope" }).click();
    await emails(page).fill("you@example.com");
    await page.getByRole("button", { name: "Send 3 invitations" }).click();
    await expect(page.getByRole("heading", { name: /invitations? sent$/ })).toBeVisible();
    await check("results", theme);
  }
});
