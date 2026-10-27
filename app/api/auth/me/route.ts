import { NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";

export async function GET(req: Request) {
  const token = req.headers.get("cookie")?.match(/xp_session=([^;]+)/)?.[1];
  if (!token) return NextResponse.json({ user: null });
  const user = await verifySessionToken(token);
  if (!user) return NextResponse.json({ user: null });
  return NextResponse.json({ user });
}
