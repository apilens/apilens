import { describe, expect, it, vi } from "vitest";
import { SIGNED_OUT_PATH as SERVER_SIGNED_OUT_PATH } from "./auth-routes";
import { SIGNED_OUT_PATH, signOut } from "./sign-out";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("signOut", () => {
  it("posts to /api/auth/logout with the session cookie", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/sign-in?reason=signed_out" }));
    await signOut(fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/auth/logout");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
  });

  it("follows the Route Handler's next", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "/sign-in?reason=signed_out" }));
    expect(await signOut(fetcher)).toBe("/sign-in?reason=signed_out");
  });

  it("ignores a next that is not the sign-in page", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true, next: "https://evil.example/sign-in" }));
    expect(await signOut(fetcher)).toBe(SIGNED_OUT_PATH);
  });

  it("still lands on sign-in when the request fails or is refused", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await signOut(offline)).toBe(SIGNED_OUT_PATH);
    const refused = vi.fn<typeof fetch>(async () => json(403, { ok: false, code: "bad_origin" }));
    expect(await signOut(refused)).toBe(SIGNED_OUT_PATH);
    const garbage = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 502 }));
    expect(await signOut(garbage)).toBe(SIGNED_OUT_PATH);
  });

  it("matches the server's signed-out path", () => {
    expect(SIGNED_OUT_PATH).toBe(SERVER_SIGNED_OUT_PATH);
  });
});
