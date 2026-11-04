// Accessibility and visual pass on every auth screen (#324), against the fake identity: axe finds
// no serious or critical violations in light and dark at 1440 and 390 px, tab order reaches the
// form before the brand panel, buttons are 44 px tall on a phone, the code-box cursor and loading
// rings hold still under reduced motion, and every screen paints its form without JavaScript.
//
// Screenshots of every screen, theme and width: `AUTH_SHOTS=<dir> pnpm test:e2e:fake auth-a11y`.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const EMAIL = "you@example.com";

/** Every auth screen, by the state it shows, with the `h1` that says it has painted. */
const SCREENS: { name: string; path: string; title: string | RegExp }[] = [
  { name: "sign-in", path: "/sign-in", title: "Welcome back" },
  { name: "sign-in-callback-error", path: "/sign-in?error=oauth_identity_taken", title: "Welcome back" },
  { name: "sign-in-session-expired", path: "/sign-in?reason=session_expired", title: "Welcome back" },
  { name: "sign-up", path: "/sign-up", title: "Create your APILens account" },
  { name: "verify-sign-in", path: `/verify?${new URLSearchParams({ email: EMAIL, flow: "signin" })}`, title: "Check your inbox" },
  { name: "verify-sign-up", path: `/verify?${new URLSearchParams({ email: EMAIL, flow: "signup", retry_after: "30" })}`, title: "Check your inbox" },
  { name: "magic-link-problem", path: `/verify?${new URLSearchParams({ token: "ml_unknown", email: EMAIL })}`, title: /Link expired|couldn’t sign you in/ },
  { name: "two-factor", path: "/auth/2fa", title: "Two-factor authentication" },
  { name: "recovery", path: `/auth/recovery?${new URLSearchParams({ email: EMAIL })}`, title: "Lost your device?" },
  { name: "recovery-status", path: "/auth/recovery/status?token=rc_unknown", title: /Link not valid|couldn’t load/ },
  { name: "recovery-cancel", path: "/auth/recovery/cancel?token=rc_unknown", title: /Link not valid|couldn’t load/ },
];

const THEMES = ["dark", "light"] as const;
const WIDTHS = [1440, 390] as const;

async function open(page: Page, path: string, title: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function serious(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`axe: no serious violations, ${theme} at ${width} px`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      const shots = process.env.AUTH_SHOTS;
      for (const s of SCREENS) {
        await open(page, s.path, s.title);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await serious(page), `${s.name} (${theme}, ${width} px)`).toEqual([]);
        if (shots) await page.screenshot({ path: `${shots}/${s.name}-${theme}-${width}.png` });
      }
    });
  }
}

test("tab order reaches the form before the brand panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const s of SCREENS) {
    await open(page, s.path, s.title);
    const order = await page.evaluate(() => {
      const focusable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0,
      );
      return {
        positive: focusable.filter((el) => el.tabIndex > 0).length,
        inForm: focusable.map((el) => el.closest("main") !== null),
        h1BeforePanel: (() => {
          const h1 = document.querySelector("h1");
          const panel = document.querySelector(".ob-bp");
          return !!h1 && !!panel && (h1.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        })(),
      };
    });
    expect(order.positive, s.name).toBe(0);
    // Every control in the form comes before every control in the brand panel.
    expect(order.inForm.indexOf(false) === -1 || order.inForm.lastIndexOf(true) < order.inForm.indexOf(false), s.name).toBe(true);
    expect(order.h1BeforePanel, s.name).toBe(true);
  }
});

test("sign-in tab order: email, passkey, then the other methods", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/sign-in", "Welcome back");
  await expect(page.getByLabel("Work email")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Continue with a passkey" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Email code" })).toBeFocused();
});

test("errors are tied to their field with aria-invalid and aria-describedby", async ({ page }) => {
  await open(page, "/sign-up", "Create your APILens account");
  const field = page.getByLabel("Work email");
  await field.fill("not-an-email");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(/Enter a work email/);

  await open(page, "/sign-in", "Welcome back");
  await page.getByLabel("Work email").fill("nope");
  await page.getByLabel("Work email").blur();
  await expect(page.getByLabel("Work email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Work email")).toHaveAccessibleDescription(/Enter a work email/);
});

test("buttons are at least 44 px tall at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const s of SCREENS) {
    await open(page, s.path, s.title);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".ob2 .ah-btn, .ob-notice-x")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ text: el.textContent?.trim() || el.getAttribute("aria-label"), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
        .filter((b) => b.h < 44 || b.w < 44),
    );
    expect(small, s.name).toEqual([]);
    // No horizontal scroll on a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth), s.name).toBeLessThanOrEqual(390);
  }
});

test("reduced motion stills the code-box cursor and the loading ring", async ({ browser }) => {
  const animations = async (reducedMotion: "reduce" | "no-preference") => {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await open(page, `/verify?${new URLSearchParams({ email: EMAIL, flow: "signin" })}`, "Check your inbox");
    const names = await page.evaluate(() => {
      const cursor = document.querySelector(".ob-code6 span.cur");
      const button = document.querySelector<HTMLElement>(".ob-actions .ah-btn");
      button?.classList.add("is-loading");
      return {
        cursor: cursor ? getComputedStyle(cursor, "::after").animationName : "missing",
        loading: button ? getComputedStyle(button, "::after").animationName : "missing",
      };
    });
    await ctx.close();
    return names;
  };
  expect(await animations("no-preference")).toEqual({ cursor: "obBlink", loading: "obSpin" });
  expect(await animations("reduce")).toEqual({ cursor: "none", loading: "none" });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("every screen paints its heading and form on first load", async ({ page }) => {
    for (const s of SCREENS) {
      await open(page, s.path, s.title);
    }
    await page.goto("/sign-in");
    await expect(page.getByLabel("Work email")).toBeVisible();
    await page.goto("/sign-up");
    await expect(page.getByLabel("Work email")).toBeVisible();
    await page.goto(`/verify?${new URLSearchParams({ email: EMAIL })}`);
    await expect(page.getByLabel("6-digit code")).toBeAttached();
    await page.goto("/auth/2fa");
    await expect(page.getByLabel("6-digit code")).toBeAttached();
    await page.goto("/auth/recovery");
    await expect(page.getByLabel("Work email")).toBeVisible();
  });

  test("/verify without an address goes to sign-in on the server", async ({ page }) => {
    await page.goto("/verify?next=%2Facme%2Frequests");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Facme%2Frequests$/);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  });
});
