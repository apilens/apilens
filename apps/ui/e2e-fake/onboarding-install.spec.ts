// "Install" (#333) against the fake identity: the first visit creates one ingest key named
// "Onboarding" and shows it once with a copy button, the snippets carry it, the key is masked after
// navigating away and back ("Create a new key" makes another), and "I'll do this later" finishes
// onboarding on the project with a reminder banner.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** Signs a new fake user in and walks onboarding up to the install step with `language` over `method`. */
async function toInstallStep(page: Page, org: string, project: string, language: string, method: RegExp) {
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
  await page.getByRole("radio", { name: language, exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: method }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  await expect(page.getByRole("heading", { name: "Install" })).toBeVisible();
}

const keyField = (page: Page) => page.getByRole("textbox", { name: "Ingest key" });

test("install: one key shown once, snippets with it, masked after navigation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await toInstallStep(page, "Kramerica", "Kramerica Oil", "Python", /^APILens SDK/);

  // The key is created on the first visit and shown in full.
  await expect(keyField(page)).toHaveValue(/^apl_live_[\w-]+$/);
  const raw = await keyField(page).inputValue();
  await expect(page.getByText("This is the only time the full key is shown.")).toBeVisible();

  // Copy puts it on the clipboard.
  await page.getByRole("button", { name: "Copy API key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied to the clipboard." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);

  // The Python snippets carry the key, the app id and the ingest URL.
  await expect(page.locator(".ob-code pre").filter({ hasText: "pip install apilenss" })).toBeVisible();
  await expect(page.locator(".ob-code pre").filter({ hasText: `export APILENS_API_KEY=${raw}` })).toBeVisible();
  const code = page.locator(".ob-code pre").filter({ hasText: "ApiLensMiddleware" });
  await expect(code).toContainText('app_id="kramerica-oil"');
  await expect(code).toContainText('base_url="http://localhost:8080/v1"');
  await page.getByRole("button", { name: "Copy main.py" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("ApiLensMiddleware");

  // Leaving and coming back: the raw key is gone, masked, and the snippets use a placeholder.
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  await expect(keyField(page)).toHaveValue(`${raw.slice(0, 16)}…`);
  await expect(page.getByRole("button", { name: "Copy API key" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(raw);
  await expect(page.locator(".ob-code pre").filter({ hasText: "export APILENS_API_KEY=<your-ingest-key>" })).toBeVisible();

  // "Create a new key" makes another, shown once.
  await page.getByRole("button", { name: "Create a new key" }).click();
  await expect(keyField(page)).toHaveValue(/^apl_live_[\w-]+$/);
  expect(await keyField(page).inputValue()).not.toBe(raw);

  // Both are in Access › API keys as "Onboarding" ingest keys: the first visit made exactly one.
  await page.goto("/kramerica-oil/access/keys");
  await expect(page.getByRole("row").filter({ hasText: "Onboarding" })).toHaveCount(2);
});

test("install: OTLP shows the exporter environment; later finishes onboarding with a reminder", async ({ page }) => {
  await toInstallStep(page, "Pendant Publishing", "Pendant Books", "Go", /^OpenTelemetry/);
  await expect(keyField(page)).toHaveValue(/^apl_live_[\w-]+$/);
  const raw = await keyField(page).inputValue();
  const env = page.locator(".ob-code pre").filter({ hasText: "OTEL_EXPORTER_OTLP_ENDPOINT" });
  await expect(env).toContainText("export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8080/otlp");
  await expect(env).toContainText(`export OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${raw}`);
  await expect(env).toContainText("export OTEL_RESOURCE_ATTRIBUTES=apilens.app=pendant-books");

  await page.getByRole("button", { name: "I’ll do this later" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/pendant-books/") && url.searchParams.get("setup") === "later");
  const reminder = page.getByRole("status").filter({ hasText: "Finish setting up" });
  await expect(reminder).toBeVisible();
  await expect(reminder.getByRole("link", { name: "API keys" })).toHaveAttribute("href", "/pendant-books/access/keys");
  // Onboarding is finished: its pages send the user to a project (the fake's last one).
  await page.goto("/onboarding/install");
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding/"));
});

// #333: visual check of the install step in light and dark at 1440 and 390 px, with axe finding
// no serious or critical violations. Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding-install`.
test("install passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(120_000);
  await toInstallStep(page, "Vandelay Industries", "Latex Exports", "Node.js", /^APILens SDK/);
  await expect(keyField(page)).toHaveValue(/^apl_live_[\w-]+$/);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Install" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad, `${theme} at ${width} px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shots = process.env.AUTH_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/onboarding-install-${theme}-${width}.png`, fullPage: true });
    }
  }
});
