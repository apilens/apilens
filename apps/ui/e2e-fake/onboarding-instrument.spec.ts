// "How do you want to instrument?" (#332) against the fake identity: language, runtime and method
// radio groups are keyboard navigable, the recommended method follows the language, Continue saves
// the answers and goes on to the install step, and a refresh resumes with them.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const TITLE = "How do you want to instrument?";

/** Signs a new fake user in, creates organization `org` and project `project`, landing on the instrument step. */
async function toInstrumentStep(page: Page, org: string, project: string) {
  await page.goto("/sign-in");
  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  // Nothing to join: the join step goes straight on to naming an organization.
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill(org);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await page.getByLabel("Name", { exact: true }).fill(project);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
}

test("instrument: keyboard radio groups, recommended method, saved answers", async ({ page }) => {
  await toInstrumentStep(page, "Vandelay", "Vandelay Imports");
  await expect(page.locator('.ob-st[aria-current="step"]')).toHaveText("Instrument");
  await expect(page.locator(".ob-p").first()).toContainText("Vandelay Imports");

  const languages = page.getByRole("radiogroup", { name: "Language" });
  const runtimes = page.getByRole("radiogroup", { name: "Where it runs" });
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  // Languages without an SDK or OTLP path can't be picked.
  for (const name of ["Browser", "iOS", "Android"]) await expect(languages.getByRole("radio", { name })).toBeDisabled();

  // One Tab stop per group; arrows move and check, wrapping past the disabled ones.
  const python = languages.getByRole("radio", { name: "Python" });
  await python.focus();
  await page.keyboard.press("ArrowRight");
  const node = languages.getByRole("radio", { name: "Node.js" });
  await expect(node).toBeFocused();
  await expect(node).toHaveAttribute("aria-checked", "true");
  await expect(languages.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(languages.getByRole("radio", { name: "Ruby" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(python).toBeFocused();
  await expect(python).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(languages.getByRole("radio", { name: "Ruby" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(languages.getByRole("radio", { name: "Java" })).toHaveAttribute("aria-checked", "true");

  // Tab leaves the language group for the runtime group.
  await page.keyboard.press("Tab");
  await expect(runtimes.getByRole("radio", { name: /^Kubernetes/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(runtimes.getByRole("radio", { name: /^Docker or VM/ })).toHaveAttribute("aria-checked", "true");

  // The SDK is recommended for Java and checked; URL checks come later.
  const methods = page.getByRole("radiogroup", { name: "Method" });
  await expect(methods.getByRole("radio", { name: /^APILens SDK/ })).toHaveAttribute("aria-checked", "true");
  await expect(methods.getByRole("radio", { name: /^APILens SDK/ })).toContainText("Recommended");
  await expect(methods.getByRole("radio", { name: /^Check a URL/ })).toBeDisabled();
  // Go has no SDK: OpenTelemetry is recommended instead.
  await languages.getByRole("radio", { name: "Go" }).click();
  await expect(methods.getByRole("radio", { name: /^APILens SDK/ })).toBeDisabled();
  await expect(methods.getByRole("radio", { name: /^OpenTelemetry/ })).toHaveAttribute("aria-checked", "true");

  // Pick Java with OTLP over the recommendation, then Continue saves and moves on.
  await languages.getByRole("radio", { name: "Java" }).click();
  await methods.getByRole("radio", { name: /^OpenTelemetry/ }).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(methods.getByRole("radio", { name: /^OpenTelemetry/ })).toHaveAttribute("aria-checked", "true");
  await expect(cont).toBeEnabled();
  await cont.click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");

  // Coming back resumes with the saved answers.
  await page.goto("/onboarding/instrument");
  await expect(languages.getByRole("radio", { name: "Java" })).toHaveAttribute("aria-checked", "true");
  await expect(runtimes.getByRole("radio", { name: /^Docker or VM/ })).toHaveAttribute("aria-checked", "true");
  await expect(methods.getByRole("radio", { name: /^OpenTelemetry/ })).toHaveAttribute("aria-checked", "true");
});

// #332: visual check of the instrument step in light and dark at 1440 and 390 px, with axe finding
// no serious or critical violations. Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding-instrument`.
test("instrument passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(120_000);
  await toInstrumentStep(page, "Hooli Labs", "Nucleus Edge");
  await page.getByRole("radio", { name: "Python" }).click();
  await page.getByRole("radio", { name: /^Kubernetes/ }).click();
  // Saved, so every reload below shows the picks.
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  await page.goto("/onboarding/instrument");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
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
      if (shots) await page.screenshot({ path: `${shots}/onboarding-instrument-${theme}-${width}.png`, fullPage: true });
    }
  }
});
