// Passkeys on `/sign-in` (#319) and the identifier-first Continue, driven by Chrome's CDP virtual
// authenticator.
//
// The authenticator holds a discoverable P-256 passkey for rpId `localhost` whose private key the
// test generates, so the browser produces a real assertion. The `/api/auth/passkeys/login/*`
// Route Handlers are stubbed with `page.route`: the stub hands out a challenge and checks the
// assertion's signature with the matching public key, so the page's WebAuthn plumbing
// (JSON <-> ArrayBuffer, mediation, abort) is tested end to end without a registered account.
// `/api/auth/email/start` is stubbed wherever Continue would send a code: no email is sent by any
// test here.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { type CDPSession, type Page, type Route, expect, test } from "@playwright/test";

const b64u = (b: Buffer) => b.toString("base64url");

interface Passkey {
  credentialId: Buffer;
  privateKeyPkcs8: Buffer;
  publicKeyPem: string;
}

function newPasskey(): Passkey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentialId: randomBytes(16),
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

async function virtualAuthenticator(page: Page, passkey?: Passkey): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (passkey) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: residentCredential(passkey) });
  return { cdp, authenticatorId };
}

/** `passkey` as a discoverable credential for rpId `localhost` (CDP wants standard base64). */
function residentCredential(passkey: Passkey) {
  return {
    credentialId: passkey.credentialId.toString("base64"),
    isResidentCredential: true,
    rpId: "localhost",
    privateKey: passkey.privateKeyPkcs8.toString("base64"),
    userHandle: Buffer.from("usr_e2e").toString("base64"),
    signCount: 0,
  };
}

interface Stub {
  /** Bodies the page sent to `/options`, in order. */
  optionsBodies: Record<string, unknown>[];
  /** Bodies the page sent to `/verify`, in order. */
  verifyBodies: Record<string, unknown>[];
}

/**
 * Stubs the passkey Route Handlers. `/verify` answers `{ok: true, next: "/landed"}` when the
 * assertion is signed by `passkey` over the challenge it issued, else `verifyFailure`.
 */
async function stubPasskeyRoutes(
  page: Page,
  passkey: Passkey | undefined,
  verifyFailure = { status: 401, body: { ok: false, code: "passkey_failed" } },
): Promise<Stub> {
  const stub: Stub = { optionsBodies: [], verifyBodies: [] };
  const challenges = new Map<string, Buffer>();
  await page.route("**/api/auth/passkeys/login/options", async (route: Route) => {
    stub.optionsBodies.push(route.request().postDataJSON() ?? {});
    const challenge = randomBytes(32);
    const id = `ch_${challenges.size + 1}`;
    challenges.set(id, challenge);
    await route.fulfill({
      json: {
        ok: true,
        next: "/sign-in",
        challenge_id: id,
        options: { publicKey: { challenge: b64u(challenge), rpId: "localhost", timeout: 60_000, userVerification: "preferred" } },
      },
    });
  });
  await page.route("**/api/auth/passkeys/login/verify", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    stub.verifyBodies.push(body);
    const cred = body.credential as { id: string; response: Record<string, string> };
    const challenge = challenges.get(String(body.challenge_id));
    let ok = false;
    if (passkey && challenge && cred.id === b64u(passkey.credentialId)) {
      const clientData = Buffer.from(cred.response.clientDataJSON, "base64url");
      const parsed = JSON.parse(clientData.toString()) as { type: string; challenge: string };
      const signed = Buffer.concat([
        Buffer.from(cred.response.authenticatorData, "base64url"),
        createHash("sha256").update(clientData).digest(),
      ]);
      ok =
        parsed.type === "webauthn.get" &&
        parsed.challenge === b64u(challenge) &&
        verify("sha256", signed, createPublicKey(passkey.publicKeyPem), Buffer.from(cred.response.signature, "base64url"));
    }
    if (ok) await route.fulfill({ json: { ok: true, next: "/landed", email: "ada@example.com" } });
    else await route.fulfill({ status: verifyFailure.status, json: verifyFailure.body });
  });
  await page.route("**/landed*", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Signed in</h1>" }));
  return stub;
}

const passkeyButton = (page: Page) => page.getByRole("button", { name: "Passkey", exact: true });
const continueButton = (page: Page) => page.getByRole("button", { name: "Continue" });
/** `/verify`, where a sent code lands (the email start is stubbed, so nothing is sent). */
const codeScreen = (page: Page) => page.getByRole("heading", { name: "Check your inbox" });

const REMEMBERED_KEY = "apilens.remembered-account";

/** This device "remembers" `email`, last signed in with `method`. */
const rememberOnDevice = (page: Page, email: string, method?: "passkey" | "email") =>
  page.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("__seeded")) {
        localStorage.setItem(key, value);
        sessionStorage.setItem("__seeded", "1");
      }
    },
    [REMEMBERED_KEY, JSON.stringify({ email, at: Date.now(), ...(method ? { method } : {}) })],
  );

const remembered = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null, REMEMBERED_KEY);

/** Stubs the email code start (nothing is sent) and counts the calls. */
async function stubEmailStart(page: Page, reply: { status: number; json: unknown } = { status: 200, json: { ok: true, next: "/landed" } }) {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/auth/email/start", async (route) => {
    calls.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill(reply);
  });
  return calls;
}
const problem = (page: Page) => page.locator(".ob-err[role=alert]");

/**
 * Turns autofill off: the virtual authenticator answers a conditional request on its own, which
 * would sign in before the button is pressed.
 */
const withoutAutofill = (page: Page) =>
  page.addInitScript(() => {
    if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });

test("signs in with the passkey button", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);
  await withoutAutofill(page);

  await page.goto("/sign-in?next=%2Flanded");
  await page.getByLabel("Work email").fill("ada@example.com");
  await passkeyButton(page).click();

  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  // The typed address narrows the options; the assertion goes back with the challenge and next.
  expect(stub.optionsBodies).toEqual([{ email: "ada@example.com" }]);
  expect(stub.verifyBodies).toHaveLength(1);
  expect(stub.verifyBodies[0]).toMatchObject({ next: "/landed", credential: { id: b64u(passkey.credentialId), type: "public-key" } });
  // The device remembers the account and that it signed in with a passkey.
  expect(await remembered(page)).toMatchObject({ email: "ada@example.com", method: "passkey" });
});

test("offers the passkey in the email field's autofill (conditional UI)", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);

  await page.goto("/sign-in");
  // On mount the page starts a conditional request with fully discoverable options.
  await expect.poll(() => stub.optionsBodies.length).toBeGreaterThanOrEqual(1);
  expect(stub.optionsBodies[0]).toEqual({});
  // The virtual authenticator answers the pending request as if the passkey was picked from the
  // email field's autofill; the button is never pressed.
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  expect(stub.verifyBodies).toHaveLength(1);
});

test("the button cancels a pending autofill request first", async ({ page }) => {
  // No passkey yet, so the conditional request started on mount stays pending.
  const passkey = newPasskey();
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  const stub = await stubPasskeyRoutes(page, passkey);

  await page.goto("/sign-in");
  await expect.poll(() => stub.optionsBodies.length).toBe(1);
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: residentCredential(passkey) });
  await passkeyButton(page).click();

  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  expect(stub.optionsBodies).toEqual([{}, {}]);
  expect(stub.verifyBodies).toHaveLength(1);
  expect(stub.verifyBodies[0].challenge_id).toBe("ch_2");
});

test("Continue cancels the pending autofill request", async ({ page }) => {
  await virtualAuthenticator(page);
  const stub = await stubPasskeyRoutes(page, undefined);
  // Record each conditional request's signal; the email start is stubbed (nothing is sent).
  await page.addInitScript(() => {
    const signals: AbortSignal[] = [];
    (window as unknown as { __signals: AbortSignal[] }).__signals = signals;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (o?: CredentialRequestOptions) => {
      if (o?.mediation === "conditional" && o.signal) signals.push(o.signal);
      return get(o);
    };
  });
  await page.route("**/api/auth/email/start", (route) =>
    route.fulfill({ status: 429, json: { ok: false, code: "rate_limited", retry_after: 30 } }),
  );
  const aborted = () =>
    page.evaluate(() => (window as unknown as { __signals: AbortSignal[] }).__signals.map((s) => s.aborted));

  await page.goto("/sign-in");
  await expect.poll(aborted).toEqual([false]);
  await page.getByLabel("Work email").fill("ada@example.com");
  await continueButton(page).click();
  await expect(problem(page)).toContainText("Too many attempts. Try again in");
  // The first request was cancelled; autofill is offered again since the page is still here.
  await expect.poll(aborted).toEqual([true, false]);
  expect(stub.verifyBodies).toHaveLength(0);
});

test("an unknown passkey says so and leaves the email path open", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  await stubPasskeyRoutes(page, undefined, { status: 401, body: { ok: false, code: "passkey_unknown" } });
  await withoutAutofill(page);

  await page.goto("/sign-in");
  await passkeyButton(page).click();
  await expect(problem(page)).toHaveText("No passkey for this account on this device. Use your email instead.");
  await expect(passkeyButton(page)).toBeEnabled();
  // Continue, the one primary action, still sends a code.
  await expect(continueButton(page)).toHaveClass(/ah-btn--primary/);
  await expect(continueButton(page)).toBeEnabled();
});

test("a cancelled ceremony is silent", async ({ page }) => {
  // An authenticator with no passkey: Chrome rejects with NotAllowedError, as when the user
  // dismisses the sheet.
  await virtualAuthenticator(page);
  const stub = await stubPasskeyRoutes(page, undefined);
  await withoutAutofill(page);

  await page.goto("/sign-in");
  await passkeyButton(page).click();
  await expect.poll(() => stub.optionsBodies.length).toBeGreaterThanOrEqual(1);
  await expect(passkeyButton(page)).toBeEnabled();
  await expect(problem(page)).toHaveCount(0);
  // Leaving the empty email field for the passkey button is not an invalid email.
  await expect(page.getByText("Enter a work email like you@company.com.")).toHaveCount(0);
  expect(stub.verifyBodies).toHaveLength(0);
});

test("hides the button when the browser has no WebAuthn", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error: simulating a browser without WebAuthn.
    delete window.PublicKeyCredential;
  });
  await page.goto("/sign-in");
  await expect(continueButton(page)).toHaveClass(/ah-btn--primary/);
  await expect(passkeyButton(page)).toHaveCount(0);
});

// --- Identifier first: Continue decides ---------------------------------------------------------

test("Continue opens the passkey for an account this device signed in to with one", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);
  const starts = await stubEmailStart(page);
  await rememberOnDevice(page, "ada@example.com", "passkey");

  await page.goto("/sign-in?next=%2Flanded");
  await expect(page.getByText("ada@example.com")).toBeVisible();
  await expect(page.getByText("You’ll confirm with the passkey you used on this device.")).toBeVisible();
  // Continue already means the passkey, so it is not offered twice.
  await expect(passkeyButton(page)).toHaveCount(0);
  await continueButton(page).click();

  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  expect(stub.optionsBodies).toEqual([{ email: "ada@example.com" }]);
  expect(starts).toHaveLength(0);
});

test("a passkey that does not sign in hands Continue to the email code", async ({ page }) => {
  // No credential on the authenticator: the browser rejects as when the sheet is dismissed.
  await virtualAuthenticator(page);
  const stub = await stubPasskeyRoutes(page, undefined);
  const starts = await stubEmailStart(page);
  await rememberOnDevice(page, "ada@example.com", "passkey");

  await page.goto("/sign-in");
  await continueButton(page).click();
  await expect(problem(page)).toHaveText("Your passkey didn’t sign you in. Continue to get a code by email instead.");
  await expect(continueButton(page)).toBeFocused();
  expect(starts).toHaveLength(0);
  // The passkey stays one click away, and Continue now sends the code.
  await expect(passkeyButton(page)).toBeVisible();
  await expect(page.getByText("We’ll email you a 6-digit code.")).toBeVisible();
  await continueButton(page).click();
  await expect(codeScreen(page)).toBeVisible();
  expect(starts).toEqual([{ email: "ada@example.com", intent: "signin" }]);
  expect(stub.verifyBodies).toHaveLength(0);
});

test("offline keeps the passkey route and says it is the connection", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  await page.route("**/api/auth/passkeys/login/options", (route) => route.abort("internetdisconnected"));
  const starts = await stubEmailStart(page);
  await rememberOnDevice(page, "ada@example.com", "passkey");

  await page.goto("/sign-in");
  await continueButton(page).click();
  await expect(problem(page)).toHaveText("Couldn’t reach APILens. Check your connection and try again.");
  // Still the passkey route: no code sent, the note unchanged.
  await expect(page.getByText("You’ll confirm with the passkey you used on this device.")).toBeVisible();
  await expect(passkeyButton(page)).toHaveCount(0);
  expect(starts).toHaveLength(0);
});

test("a passkey removed from the account sends a code at once and forgets the shortcut", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  await stubPasskeyRoutes(page, undefined, { status: 401, body: { ok: false, code: "passkey_unknown" } });
  const starts = await stubEmailStart(page);
  await rememberOnDevice(page, "ada@example.com", "passkey");

  await page.goto("/sign-in");
  await continueButton(page).click();
  await expect(codeScreen(page)).toBeVisible();
  expect(starts).toEqual([{ email: "ada@example.com", intent: "signin" }]);
  const left = await remembered(page);
  expect(left).toMatchObject({ email: "ada@example.com" });
  expect(left?.method).toBeUndefined();
});

test("an account last signed in by email gets a code, never a passkey prompt", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);
  const starts = await stubEmailStart(page);
  await rememberOnDevice(page, "ada@example.com", "email");

  await page.goto("/sign-in");
  await expect(page.getByText("We’ll email you a 6-digit code.")).toBeVisible();
  await continueButton(page).click();
  await expect(codeScreen(page)).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(stub.optionsBodies).toHaveLength(0);
});

test("a typed address gets a code, whatever passkeys the device holds", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);
  const starts = await stubEmailStart(page);
  await withoutAutofill(page);

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("Ada@Example.com ");
  await page.getByLabel("Work email").press("Enter");
  await expect(codeScreen(page)).toBeVisible();
  expect(starts).toEqual([{ email: "Ada@Example.com", intent: "signin" }]);
  expect(stub.optionsBodies).toHaveLength(0);
});

test("an invalid address is flagged, sends nothing and keeps focus in the field", async ({ page }) => {
  await virtualAuthenticator(page);
  await stubPasskeyRoutes(page, undefined);
  const starts = await stubEmailStart(page);
  await withoutAutofill(page);

  await page.goto("/sign-in");
  await continueButton(page).click();
  const field = page.getByLabel("Work email");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  expect(starts).toHaveLength(0);
});

test("a misspelt provider domain gets a one-tap suggestion", async ({ page }) => {
  await virtualAuthenticator(page);
  await stubPasskeyRoutes(page, undefined);
  await withoutAutofill(page);

  await page.goto("/sign-in");
  const field = page.getByLabel("Work email");
  await field.fill("ada@gmial.com");
  await expect(field).toHaveAccessibleDescription(/Did you mean ada@gmail.com/);
  await page.getByRole("button", { name: "ada@gmail.com" }).click();
  await expect(field).toHaveValue("ada@gmail.com");
  await expect(page.getByText("Did you mean")).toHaveCount(0);
});

test("Back from the code screen returns to the address that was typed", async ({ page }) => {
  await virtualAuthenticator(page);
  await stubPasskeyRoutes(page, undefined);
  await stubEmailStart(page);
  await withoutAutofill(page);

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("ada@example.com");
  await continueButton(page).click();
  await expect(codeScreen(page)).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Work email")).toHaveValue("ada@example.com");
});

test("Not you? forgets the account and puts the cursor in an empty field", async ({ page }) => {
  await virtualAuthenticator(page);
  await stubPasskeyRoutes(page, undefined);
  await withoutAutofill(page);
  await rememberOnDevice(page, "ada@example.com", "passkey");

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Not you?" }).click();
  const field = page.getByLabel("Work email");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  expect(await remembered(page)).toBeNull();
});

test("the code screen offers a passkey instead", async ({ page }) => {
  const passkey = newPasskey();
  await virtualAuthenticator(page, passkey);
  const stub = await stubPasskeyRoutes(page, passkey);

  await page.goto("/verify?flow=signin&email=ada%40example.com&next=%2Flanded");
  await page.getByRole("button", { name: "Use a passkey instead" }).click();
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  expect(stub.optionsBodies).toEqual([{ email: "ada@example.com" }]);
  expect(await remembered(page)).toMatchObject({ email: "ada@example.com", method: "passkey" });
});

test("signing up, the code screen offers no passkey", async ({ page }) => {
  await virtualAuthenticator(page);
  await page.goto("/verify?flow=signup&email=ada%40example.com");
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a passkey instead" })).toHaveCount(0);
});
