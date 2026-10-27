import { NextResponse, type NextRequest } from "next/server";
import { AUTOMATION_COOKIE, verifyAutomationToken } from "@/lib/automation-cookie";

/**
 * Server-side gate for the automation control surface.
 *
 * The panel is reachable over the public tunnel (repostops.xyz), so the
 * automation API must NEVER answer an unauthenticated caller. This is a
 * SEPARATE door from the panel login: it checks the `xp_auto` cookie, which is
 * only issued after the automation ID + password are entered at /automation.
 *
 * /api/automation/auth is deliberately excluded — that is the login itself, and
 * must stay reachable so the first-time setup can happen.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/api/automation/auth") return NextResponse.next();

  const token = req.cookies.get(AUTOMATION_COOKIE)?.value;
  if (!(await verifyAutomationToken(token))) {
    return NextResponse.json({ error: "Automation login required" }, { status: 401 });
  }

  return NextResponse.next();
}

// Only the data endpoints. The /automation page is public so it can draw the
// login form — it holds no data of its own, every value comes from these APIs.
export const config = {
  matcher: ["/api/automation", "/api/automation/:path*"],
};
