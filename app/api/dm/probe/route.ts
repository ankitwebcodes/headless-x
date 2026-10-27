import { getUser, json } from "@/lib/reqAuth";
import { getSession } from "@/lib/dm-store";
import { probeDm } from "@/lib/xdm";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false, error: "Unauthorized" },401);
  try {
    const body = await req.json();
    const acct = await getSession(user.id,String(body.id));
    if (!acct) return json({ ok: false, error: "Account not found" },404);
    return json({ ...await probeDm(acct.sessionJson), sessionId: acct.id, label: acct.label });
  } catch (e) { return json({ ok: false, error: (e as Error).message },400); }
}
