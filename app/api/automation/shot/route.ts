import fs from "node:fs";
import { json } from "@/lib/reqAuth";
import { hasAutomationSession } from "@/lib/automation-auth";
import { bridge, SHOT_F } from "@/lib/xflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve the latest tiled montage. ?refresh=1 recaptures first (takes a few s). */
export async function GET(req: Request) {
  if (!(await hasAutomationSession(req))) {
    return json({ error: "Automation login required" }, 401);
  }

  if (new URL(req.url).searchParams.get("refresh") === "1") {
    await bridge("/shot");
  }

  try {
    const st = fs.statSync(SHOT_F);
    const ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
    if (ageSec > 24 * 3600) return json({ error: "no recent screenshot" }, 404);
    const buf = fs.readFileSync(SHOT_F);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        "x-shot-age-sec": String(ageSec),
      },
    });
  } catch {
    return json({ error: "no screenshot yet" }, 404);
  }
}

/** Ask the live controller to recapture the montage now. */
export async function POST(req: Request) {
  if (!(await hasAutomationSession(req))) {
    return json({ error: "Automation login required" }, 401);
  }
  const r = await bridge<{ ok: boolean }>("/shot");
  return json({ ok: Boolean(r?.ok) });
}
