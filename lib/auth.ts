import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "xpanel-dev-secret-change-me"
);

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
};

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function createSessionToken(u: SessionUser): Promise<string> {
  return new SignJWT({ ...u })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as unknown as SessionUser;
  } catch {
    return null;
  }
}

export function uid(): string {
  return randomUUID();
}
