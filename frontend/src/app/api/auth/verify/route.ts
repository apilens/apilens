import { NextRequest, NextResponse } from "next/server";
import { createCipheriv, randomBytes, createHash } from "crypto";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";
const COOKIE_NAME = "apilens_session";

function encryptSession(data: object): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");

  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const userAgent = request.headers.get("user-agent") || "";

    const response = await fetch(`${DJANGO_API_URL}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: body.token,
        device_info: userAgent.substring(0, 255),
        remember_me: body.remember_me ?? true,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || "Verification failed" },
        { status: response.status },
      );
    }

    // Decode JWT to get user info (no verification needed — Django already verified)
    const payload = JSON.parse(
      Buffer.from(data.access_token.split(".")[1], "base64url").toString(),
    );

    const sessionData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: {
        id: payload.sub,
        email: payload.email,
      },
    };

    const encrypted = encryptSession(sessionData);
    const rememberMe = body.remember_me ?? true;

    const isSecure = process.env.NODE_ENV === "production" && !process.env.DJANGO_API_URL?.includes("localhost");

    const res = NextResponse.json({ success: true, flow: body.flow || null });
    res.cookies.set(COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      path: "/",
      ...(rememberMe ? { maxAge: 30 * 24 * 60 * 60 } : {}),
    });

    return res;
  } catch (error) {
    console.error("Verify error:", error);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 },
    );
  }
}
