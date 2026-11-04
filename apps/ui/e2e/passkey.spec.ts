// "Continue with a passkey" on `/sign-in` (#319), driven by Chrome's CDP virtual authenticator.
//
// The authenticator holds a discoverable P-256 passkey for rpId `localhost` whose private key the
// test generates, so the browser produces a real assertion. The `/api/auth/passkeys/login/*`
// Route Handlers are stubbed with `page.route`: the stub hands out a challenge and checks the
// assertion's signature with the matching public key, so the page's WebAuthn plumbing
// (JSON <-> ArrayBuffer, mediation, abort) is tested end to end without a registered account.
// No email is sent by any test here.
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
    if (ok) await route.fulfill({ json: { ok: true, next: "/landed" } });
    else await route.fulfill({ status: verifyFailure.status, json: verifyFailure.body });
  });
  await page.route("**/landed*", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Signed in</h1>" }));
  return stub;
}

const passkeyButton = (page: Page) => page.getByRole("button", { name: "Continue with a passkey" });
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

test("picking Email code cancels the pending autofill request", async ({ page }) => {
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
  await page.getByRole("button", { name: "Email code" }).click();
  await expect(problem(page)).toContainText("Too many codes requested");
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
  await expect(page.getByRole("button", { name: "Email code" })).toBeVisible();
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
  expect(stub.verifyBodies).toHaveLength(0);
});

test("hides the button when the browser has no WebAuthn", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error: simulating a browser without WebAuthn.
    delete window.PublicKeyCredential;
  });
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Email code" })).toBeVisible();
  await expect(passkeyButton(page)).toHaveCount(0);
});
