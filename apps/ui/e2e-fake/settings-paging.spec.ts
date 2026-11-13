// Paging and search on the settings lists (members, invitations, sessions) against the fake
// identity (e2e-fake/fake-identity.ts). The handoff's `extra` seeds numbered @example.com rows on
// top of the usual five members, three invitations and three sessions.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = process.env.FAKE_IDENTITY_URL ?? "http://localhost:18080";
const MEMBERS = "/orgs/acme/settings/members";
const INVITATIONS = "/orgs/acme/settings/invitations";
const SESSIONS = "/settings/sessions";

async function signIn(page: Page, next: string, extra: { members?: number; invitations?: number; sessions?: number }, role = "admin") {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, role, extra }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const rows = (page: Page) => page.locator("table tbody tr");
const pager = (page: Page, name: string) => page.getByRole("navigation", { name });

test("members: pages of 25, search by name or email, a page past the end lands on the last", async ({ page }) => {
  // 5 seeded + 60 = 65 members: pages of 25, 25 and 15.
  await signIn(page, MEMBERS, { members: 60 });
  await expect(page.getByText("65 members")).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  const nav = pager(page, "Members pages");
  await expect(nav.locator(".pg-range")).toHaveText("Showing 1–25 of 65");

  await nav.getByRole("link", { name: "Page 3" }).click();
  await expect(page).toHaveURL(`${MEMBERS}?page=3`);
  await expect(rows(page)).toHaveCount(15);
  await expect(nav.locator(".pg-range")).toHaveText("Showing 51–65 of 65");

  // The search starts again at page 1, and goes into the URL.
  await page.getByRole("searchbox", { name: "Search members" }).fill("teammate05");
  await expect(page.getByText("10 of 65 members match")).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(page).toHaveURL(`${MEMBERS}?q=teammate05`);
  // One page: no controls.
  await expect(nav).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search members" }).fill("nobody-by-that-name");
  await expect(page.getByText("No members match “nobody-by-that-name”")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(rows(page)).toHaveCount(25);
  await expect(page).toHaveURL(MEMBERS);

  await page.goto(`${MEMBERS}?page=9`);
  await expect(page).toHaveURL(`${MEMBERS}?page=3`);
  await expect(rows(page)).toHaveCount(15);
});

test("members: removing the only member on the last page goes back a page", async ({ page }) => {
  // 5 + 46 = 51 members: page 3 holds one, the newest (Teammate 001).
  await signIn(page, `${MEMBERS}`, { members: 46 });
  await page.goto(`${MEMBERS}?page=3`);
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Remove Teammate 001" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
  await expect(page).toHaveURL(`${MEMBERS}?page=2`);
  await expect(rows(page)).toHaveCount(25);
  await expect(page.getByText("50 members")).toBeVisible();
});

test("invitations: paged and searchable", async ({ page }) => {
  // 3 seeded + 30 = 33 pending invitations.
  await signIn(page, INVITATIONS, { invitations: 30 });
  await expect(page.getByText("33 pending invitations")).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await pager(page, "Invitations pages").getByRole("link", { name: "Next" }).click();
  await expect(rows(page)).toHaveCount(8);
  await page.getByRole("searchbox", { name: "Search invitations" }).fill("grace");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator("th")).toHaveText("grace@example.com");
});

// Visual check at 1440 and 390: `PAGING_SHOTS=<dir> pnpm test:e2e:fake settings-paging`.
test("screenshots", async ({ page }) => {
  const dir = process.env.PAGING_SHOTS;
  test.skip(!dir, "set PAGING_SHOTS to a directory to capture screenshots");
  await signIn(page, MEMBERS, { members: 60, invitations: 30, sessions: 30 }, "owner");
  const shots: [string, string][] = [
    ["members", `${MEMBERS}?page=2`],
    ["members-search", `${MEMBERS}?q=teammate05`],
    ["members-none", `${MEMBERS}?q=nobody`],
    ["invitations", `${INVITATIONS}?page=2`],
    ["sessions", SESSIONS],
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
    for (const [name, url] of shots) {
      await page.goto(url);
      await expect(page.locator("main h1")).toBeVisible();
      await page.screenshot({ path: `${dir}/${name}-${width}.png`, fullPage: true });
      // The page scrolls inside <main>: the pager sits at the end of the list.
      await page.locator("main").evaluate((m) => m.scrollTo(0, m.scrollHeight));
      await page.screenshot({ path: `${dir}/${name}-${width}-end.png` });
    }
  }
});

test("sessions: paged, the current device first", async ({ page }) => {
  // 3 seeded + 30 = 33 sessions.
  await signIn(page, SESSIONS, { sessions: 30 }, "owner");
  await expect(page.getByText("33 active sessions")).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
  await pager(page, "Sessions pages").getByRole("link", { name: "Page 2" }).click();
  await expect(page).toHaveURL(`${SESSIONS}?page=2`);
  await expect(rows(page)).toHaveCount(8);
});
