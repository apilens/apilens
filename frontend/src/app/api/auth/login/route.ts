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

    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim()
      || request.headers.get("x-real-ip")
      || "unknown";

    const response = await fetch(`${DJANGO_API_URL}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "X-Forwarded-For": clientIp,
      },
      body: JSON.stringify({
        email: body.email,
        password: body.password,
        remember_me: body.remember_me ?? true,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || "Invalid email or password" },
        { status: response.status },
      );
    }

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

    const res = NextResponse.json({ success: true });
    res.cookies.set(COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      path: "/",
      ...(rememberMe ? { maxAge: 30 * 24 * 60 * 60 } : {}),
    });

    return res;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 },
    );
  }
}
