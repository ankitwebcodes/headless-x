import { SignJWT, jwtVerify } from "jose";

/**
 * Edge-safe half of the automation gate: cookie name, signing key and token
 * helpers. Deliberately free of node:fs / bcrypt so the Next.js middleware
 * (edge runtime) can import it. The credential store lives in automation-auth.ts.
 */
const enc = new TextEncoder();
const key = enc.encode(process.env.AUTH_SECRET ?? "xpanel-dev-secret-change-me");

export const AUTOMATION_COOKIE = "xp_auto";

export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: true,
  maxAge: 7 * 24 * 3600,
};

export async function createAutomationToken(): Promise<string> {
  return new SignJWT({ typ: "automation" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

export async function verifyAutomationToken(token?: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key);
    return payload?.typ === "automation";
  } catch {
    return false;
  }
}

/** Pull the automation cookie out of a raw Cookie: header. */
export function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${AUTOMATION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
