import { getUser,json } from "@/lib/reqAuth";
import { getSession,readDmDoc,updateDmDoc } from "@/lib/dm-store";
import { defaultDmPreferences,normalizeDmPreferences,type DmPreferences } from "@/lib/dm-policy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false,error: "Unauthorized" },401);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!await getSession(user.id,id)) return json({ ok: false,error: "Account not found" },404);
  const settings = await readDmDoc<DmPreferences>(user.id,`settings:${id}`);
  return json({ ok: true,hasSaved: !!settings,settings: normalizeDmPreferences(settings ?? defaultDmPreferences) });
}
export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false,error: "Unauthorized" },401);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  if (!await getSession(user.id,id)) return json({ ok: false,error: "Account not found" },404);
  const settings = await updateDmDoc<DmPreferences>(user.id,`settings:${id}`,() => defaultDmPreferences,
    old => normalizeDmPreferences({ ...old,...body.settings }));
  return json({ ok: true,settings });
}
