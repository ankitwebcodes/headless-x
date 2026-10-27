import { NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { sql } from "drizzle-orm";

// Remote PC control bridge.
//   GET  /api/pc-control                 -> { value: "idle" | "shutdown" }  (public read)
//   GET  /api/pc-control?action=shutdown&key=XXX  -> sets flag "shutdown" (armed via URL from phone)
//   GET  /api/pc-control?action=cancel&key=XXX    -> clears flag (abort countdown)
// The flag is polled by a local watchdog script on the user's PC, which runs
// `shutdown /s /t 45` when it sees "shutdown" and `shutdown /a` when cleared.

const KEY = process.env.PC_CONTROL_KEY || "";

export async function GET(req: Request) {
  await initDb();
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const key = url.searchParams.get("key") || "";

  if (action) {
    if (!KEY) return NextResponse.json({ error: "PC_CONTROL_KEY not configured" }, { status: 500 });
    if (key !== KEY) return NextResponse.json({ error: "invalid key" }, { status: 403 });
    const value = action === "shutdown" ? "shutdown" : "idle";
    await db.execute(
      sql`INSERT INTO pc_control (id, value, updated_at) VALUES ('pc', ${value}, ${Date.now()})
          ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`
    );
    return NextResponse.json({ ok: true, value });
  }

  const rows = await db.execute(sql`SELECT value FROM pc_control WHERE id = 'pc' LIMIT 1`);
  const row = (rows as any).rows?.[0] ?? (rows as any)[0];
  return NextResponse.json({ value: row?.value ?? "idle" });
}