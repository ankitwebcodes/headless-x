import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { tokenFromCookieHeader, verifyAutomationToken } from "./automation-cookie";

export {
  AUTOMATION_COOKIE,
  COOKIE_OPTS,
  createAutomationToken,
  verifyAutomationToken,
} from "./automation-cookie";

/**
 * Credential store for the /automation door — kept OUT of the panel's user
 * table on purpose, so automation access is its own thing. The first login
 * writes the file; every later visit is checked against it.
 *
 * File: .automation-auth.json in the panel root (gitignored, chmod 600).
 * It only ever holds a bcrypt hash — never the password itself.
 */
const AUTH_FILE = path.join(process.cwd(), ".automation-auth.json");

export type AutomationCreds = {
  username: string;
  passwordHash: string;
  createdAt: number;
};

export function authFile(): string {
  return AUTH_FILE;
}

export function readCreds(): AutomationCreds | null {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (typeof j?.username === "string" && typeof j?.passwordHash === "string") {
      return j as AutomationCreds;
    }
  } catch {
    /* not set up yet, or unreadable */
  }
  return null;
}

export function isConfigured(): boolean {
  return readCreds() !== null;
}

export async function setCreds(username: string, password: string): Promise<AutomationCreds> {
  const creds: AutomationCreds = {
    username: username.trim(),
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: Date.now(),
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

export async function checkCreds(username: string, password: string): Promise<boolean> {
  const c = readCreds();
  if (!c) return false;
  if (c.username.toLowerCase() !== username.trim().toLowerCase()) return false;
  return bcrypt.compare(password, c.passwordHash);
}

/** True when the request carries a valid automation session cookie. */
export async function hasAutomationSession(req: Request): Promise<boolean> {
  return verifyAutomationToken(tokenFromCookieHeader(req.headers.get("cookie")));
}
