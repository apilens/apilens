// Accessibility and visual pass on every project settings section (#824), against the fake
// identity (e2e-fake/fake-identity.ts). Each of the twelve sections, in light and dark at 1440 and
// 390 px: one `h1` then an `h2` naming every card (no skipped levels), no sideways scroll, and axe
// finding no serious or critical WCAG 2.2 AA violations (colour contrast included). No email is sent.
// Screenshots: `PROJECT_SETTINGS_SHOTS=<dir> pnpm test:e2e:fake project-settings-a11y`.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "project.delete"];

const SECTIONS: readonly [slug: string, title: string][] = [
  ["", "General"],
  ["environments", "Environments"],
  ["sdk", "SDK setup"],
  ["capture", "Capture"],
  ["privacy", "Privacy"],
  ["retention", "Retention"],
  ["ingest", "Ingest health"],
  ["usage", "Usage"],
  ["alerts", "Alert channels"],
  ["health-checks", "Health checks"],
  ["integrations", "Integrations"],
  ["danger", "Danger zone"],
];

const path = (slug: string) => `/shop/settings${slug ? `/${slug}` : ""}`;

async function signIn(page: Page, next: string) {
  await fetch(`${IDENTITY}/__fake/project`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities: ADMIN }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

/** The section's headings in document order, and every card with the level of the heading naming it. */
const outline = (page: Page) =>
  page.locator(".psf-main").evaluate((main) => ({
    headings: Array.from(main.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter((h) => !h.closest("dialog, [role=dialog]"))
      .map((h) => Number(h.tagName[1])),
    cards: Array.from(main.querySelectorAll(".os-card")).map((card) => {
      const id = card.getAttribute("aria-labelledby");
      const named = id ? document.getElementById(id) : null;
      return named?.tagName ?? "none";
    }),
  }));

for (const [slug, title] of SECTIONS) {
  test(`${title}: one h1, an h2 per card, no sideways scroll and no serious axe findings`, async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, path(slug));
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
        await page.goto(path(slug));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator(".psf-main").getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();

        const { headings, cards } = await outline(page);
        expect(headings.filter((l) => l === 1), "one h1").toHaveLength(1);
        expect(headings[0], "the h1 comes first").toBe(1);
        headings.forEach((level, i) => {
          if (i > 0) expect(level - headings[i - 1], `heading ${i} skips a level`).toBeLessThanOrEqual(1);
        });
        expect(cards.length, "at least one card").toBeGreaterThan(0);
        expect(cards, "every card is named by an h2").toEqual(cards.map(() => "H2"));

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme} at ${width} px scrolls sideways`).toBe(true);

        const { violations } = await new AxeBuilder({ page })
          .include(".psf-main")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const bad = violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
        expect(bad, `${theme} at ${width} px`).toEqual([]);

        const shots = process.env.PROJECT_SETTINGS_SHOTS;
        if (shots) await page.screenshot({ path: `${shots}/settings-${slug || "general"}-${theme}-${width}.png`, fullPage: true });
      }
    }
  });
}
