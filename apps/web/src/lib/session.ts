import { cookies } from "next/headers";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const COOKIE_NAME = "apilens_session";
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }
  return createHash("sha256").update(secret).digest();
}

interface SessionData {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
  };
}

export async function getSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);
  if (!cookie?.value) return null;

  try {
    const key = getEncryptionKey();
    const raw = Buffer.from(cookie.value, "base64url");

    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

export async function setSession(data: SessionData, rememberMe: boolean = true): Promise<void> {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, tag, encrypted]);
  const value = combined.toString("base64url");

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !process.env.DJANGO_API_URL?.includes("localhost"),
    sameSite: "lax",
    path: "/",
    ...(rememberMe ? { maxAge: 30 * 24 * 60 * 60 } : {}), // 30 days or session-only
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
