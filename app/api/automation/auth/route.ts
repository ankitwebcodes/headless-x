import { NextResponse } from "next/server";
import {
  AUTOMATION_COOKIE,
  COOKIE_OPTS,
  checkCreds,
  createAutomationToken,
  hasAutomationSession,
  isConfigured,
  readCreds,
  setCreds,
} from "@/lib/automation-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: tells the /automation page whether setup is needed and if the
 *  caller already holds a session. Never returns the password hash. */
export async function GET(req: Request) {
  const creds = readCreds();
  const authed = await hasAutomationSession(req);
  return NextResponse.json({
    configured: Boolean(creds),
    username: creds?.username ?? null,
    authed,
  });
}

/** action=setup (first login, sets the credential) | action=login */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (action === "setup") {
    if (isConfigured()) {
      return NextResponse.json(
        { error: "Automation access is already set up — log in instead." },
        { status: 409 }
      );
    }
    if (username.length < 3) {
      return NextResponse.json(
        { error: "ID must be at least 3 characters." },
        { status: 400 }
      );
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }
    await setCreds(username, password);
    const res = NextResponse.json({ ok: true, username, first: true });
    res.cookies.set(AUTOMATION_COOKIE, await createAutomationToken(), COOKIE_OPTS);
    return res;
  }

  if (action === "login") {
    if (!isConfigured()) {
      return NextResponse.json(
        { error: "No automation login has been set up yet." },
        { status: 409 }
      );
    }
    if (!(await checkCreds(username, password))) {
      return NextResponse.json({ error: "Wrong ID or password." }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true, username: readCreds()?.username });
    res.cookies.set(AUTOMATION_COOKIE, await createAutomationToken(), COOKIE_OPTS);
    return res;
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

/** Log out of the automation area only — the panel session is untouched. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTOMATION_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  return res;
}
