// Accessibility and visual pass on the Access tabs (#814), against the fake identity
// (e2e-fake/fake-identity.ts). Members, API keys and Activity, in light and dark at 1440x900 and
// 390x844: no sideways scroll, axe finding no serious or critical WCAG 2.2 AA violations, role and
// state labels measured at 4.5:1 or better, form-control borders at 3:1 or better, every target at
// least 24x24 px, and the dialogs working from the keyboard alone. No email is sent.
// Screenshots: `ACCESS_A11Y_SHOTS=<dir> pnpm test:e2e:fake access-a11y`.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const ADMIN = ["project.read", "project.update", "api_keys.create", "api_keys.revoke", "access.manage", "audit.read"];

const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();

/** One key in every state: active, rotating, expiring, expired and revoked. */
function keys() {
  const successor = "9c0d1e2f-3a4b-4c5d-8e7f-8a9b0c1d2e3f";
  return [
    { id: successor, name: "Production backend", prefix: "apl_live_Hk27sQe", scopes: ["ingest"], created_at: iso(-26), last_used_at: iso(-0.1), environments: ["production"] },
    { name: "Production backend", prefix: "apl_live_Q2x9aZ1", scopes: ["ingest"], created_at: "2026-09-01T10:00:00Z", expires_at: iso(22), rotated_to: successor },
    { name: "Staging worker", prefix: "apl_live_r8Lm0Pq", scopes: ["ingest", "read"], created_at: "2026-08-20T10:00:00Z", expires_at: iso(24 * 5 + 6) },
    { name: "Trial", prefix: "apl_live_t1Xb4Yc", scopes: ["ingest"], created_at: "2026-07-01T10:00:00Z", expires_at: "2026-07-31T00:00:00Z" },
    { name: "Old analytics export", prefix: "apl_live_k3Vn7Ws", scopes: ["read"], created_at: "2026-06-01T10:00:00Z", revoked_at: "2026-08-15T10:00:00Z" },
  ];
}

async function signIn(page: Page, next: string) {
  await fetch(`${IDENTITY}/__fake/access`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await fetch(`${IDENTITY}/__fake/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities: ADMIN, api_keys: keys() }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

const TABS: readonly { name: string; path: string; ready: (page: Page) => Promise<void>; labels: string }[] = [
  {
    name: "Members",
    path: "/shop/access",
    ready: (page) => expect(page.getByRole("table", { name: "People with access to Shop" }).locator("tbody tr").first()).toBeVisible(),
    labels: ".am-role",
  },
  {
    name: "API keys",
    path: "/shop/access/keys?inactive=1",
    ready: (page) => expect(page.getByRole("region", { name: "API keys" }).locator("tbody tr.pk-row")).toHaveCount(5),
    labels: ".ak-status",
  },
  {
    name: "Activity",
    path: "/shop/access/activity",
    ready: (page) => expect(page.getByRole("region", { name: "Activity log", exact: true }).locator("tbody tr.acl-row").first()).toBeVisible(),
    labels: "",
  },
];

/**
 * Contrast of each element matching `selector`: its text against the background it sits on (every
 * translucent layer composited, down to the page), and the same for its border when it has one.
 * Colours are resolved through a canvas, so `color-mix()` and `oklch()` tokens come out as sRGB.
 */
const measure = (page: Page, selector: string, what: "text" | "border") =>
  page.evaluate(
    ({ selector, what }) => {
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgba = (css: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
      const behind = (el: Element | null): number[] => {
        const layers: number[][] = [];
        for (let n = el; n; n = n.parentElement) {
          const c = rgba(getComputedStyle(n).backgroundColor);
          if (c[3] > 0) layers.push(c);
          if (c[3] >= 1) break;
        }
        return layers.reduceRight((acc, l) => over(l, acc), [255, 255, 255, 1]);
      };
      const lum = (c: number[]) => {
        const [r, g, b] = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: number[], b: number[]) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      return Array.from(document.querySelectorAll(selector))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const style = getComputedStyle(el);
          if (what === "text") {
            const bg = behind(el);
            return { label: `${el.className} “${el.textContent?.trim()}”`, ratio: ratio(over(rgba(style.color), bg), bg) };
          }
          // A border sits between the control's own fill and the surface outside it: it must
          // stand out from both.
          const outside = behind(el.parentElement);
          const inside = behind(el);
          const border = over(rgba(style.borderTopColor), outside);
          return { label: `${el.tagName.toLowerCase()}.${el.className} border`, ratio: Math.min(ratio(border, outside), ratio(border, inside)) };
        });
    },
    { selector, what },
  );

for (const tab of TABS) {
  test(`${tab.name}: no sideways scroll, no serious axe findings, labels and targets measured`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, tab.path);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("theme", t), theme);
      await page.emulateMedia({ colorScheme: theme });
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
      ]) {
        const at = `${theme} at ${width} px`;
        await page.setViewportSize({ width, height });
        await page.goto(tab.path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("heading", { level: 1, name: tab.name, exact: true })).toBeVisible();
        await tab.ready(page);

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${at} scrolls sideways`).toBe(true);

        const { violations } = await new AxeBuilder({ page })
          .include(".app-main")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
        expect.soft(bad, at).toEqual([]);

        // Role and state labels: text at 4.5:1 against the pill it sits in.
        if (tab.labels) {
          const labels = await measure(page, tab.labels, "text");
          expect(labels.length, `${at}: labels found`).toBeGreaterThan(0);
          for (const l of labels) expect.soft(l.ratio, `${at}: ${l.label}`).toBeGreaterThanOrEqual(4.5);
        }
        // Non-text: the borders of the filters, selects and search fields at 3:1.
        for (const b of await measure(page, ".app-main select.om-select, .app-main .acl-select, .app-main .ak-tools__select, .app-main .ls-in", "border")) {
          expect.soft(b.ratio, `${at}: ${b.label}`).toBeGreaterThanOrEqual(3);
        }

        // Targets: 24x24 CSS px or larger (links inside running text are exempt).
        const small = await page.locator(".app-main").evaluate((main) =>
          Array.from(main.querySelectorAll<HTMLElement>("button, a[href], select, input:not([type=hidden]), [role=menuitem]"))
            .filter((el) => el.offsetParent !== null && !el.closest("p, li.am-src__list"))
            // A checkbox or radio inside its label is hit anywhere on the label.
            .map((el) => ({ el, box: (el.matches("input[type=checkbox], input[type=radio]") ? (el.closest("label") ?? el) : el).getBoundingClientRect() }))
            .filter(({ box }) => box.width < 24 || box.height < 24)
            .map(({ el, box }) => `${el.tagName.toLowerCase()} “${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim()}” ${Math.round(box.width)}x${Math.round(box.height)}`),
        );
        expect.soft(small, `${at}: targets under 24x24`).toEqual([]);

        const shots = process.env.ACCESS_A11Y_SHOTS;
        if (shots) await page.screenshot({ path: `${shots}/access-${tab.name.toLowerCase().replace(" ", "-")}-${theme}-${width}.png`, fullPage: true });
      }
    }
  });
}

test("Members by keyboard: the tabs, Add people opens a dialog that Escape closes back onto its button", async ({ page }) => {
  await signIn(page, "/shop/access");
  const nav = page.getByRole("navigation", { name: "Access", exact: true });
  await nav.getByRole("link", { name: "Members" }).focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "API keys" })).toBeFocused();

  const add = page.getByRole("button", { name: "Add people" });
  await add.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/.+/);
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
});

test("API keys by keyboard: Revoke opens on Cancel, Escape returns focus to the row's button", async ({ page }) => {
  await signIn(page, "/shop/access/keys");
  const revoke = page.getByRole("button", { name: "Revoke Staging worker" });
  await revoke.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/.+/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(revoke).toBeFocused();
});

test("Activity by keyboard: an event opens its detail panel and Escape returns focus to the row", async ({ page }) => {
  await signIn(page, "/shop/access/activity");
  const open = page.getByRole("region", { name: "Activity log", exact: true }).locator("tbody tr.acl-row").first().getByRole("button");
  await open.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAccessibleName(/.+/);
  expect(await panel.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();
});
