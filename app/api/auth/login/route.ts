import { NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { eq } from "drizzle-orm";
import {
  createSessionToken,
  hashPassword,
  uid,
  verifyPassword,
} from "@/lib/auth";

export async function POST(req: Request) {
  try {
    await initDb();
    const body = await req.json();
    const { email, password } = body || {};

    // Bootstrap: if no users exist yet, the first account is the admin.
    const all = await db.select().from(users);
    const firstRun = all.length === 0;

    if (firstRun) {
      if (!email || !password || password.length < 8) {
        return NextResponse.json(
          { error: "First run: provide email + password (min 8 chars) to create the admin account." },
          { status: 400 }
        );
      }
      const u = {
        id: uid(),
        email: String(email).toLowerCase().trim(),
        passwordHash: await hashPassword(String(password)),
        name: "Admin",
        role: "admin" as const,
        createdAt: Date.now(),
      };
      await db.insert(users).values(u);
      const token = await createSessionToken({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
      });
      const res = NextResponse.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
      res.cookies.set("xp_session", token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return res;
    }

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }
    const found = (
      await db
        .select()
        .from(users)
        .where(eq(users.email, String(email).toLowerCase().trim()))
        .limit(1)
    )[0];
    if (!found || !(await verifyPassword(String(password), found.passwordHash))) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    const token = await createSessionToken({
      id: found.id,
      email: found.email,
      name: found.name,
      role: found.role,
    });
    const res = NextResponse.json({
      user: { id: found.id, email: found.email, name: found.name, role: found.role },
    });
    res.cookies.set("xp_session", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Login failed" }, { status: 500 });
  }
}