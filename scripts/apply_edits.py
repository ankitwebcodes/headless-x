import io, sys

def edit(path, old, new, name):
    with io.open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if old not in src:
        print(f"FAIL {name}: pattern not found")
        return False
    if src.count(old) != 1:
        print(f"FAIL {name}: pattern not unique ({src.count(old)})")
        return False
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(src.replace(old, new))
    print(f"OK {name}")
    return True

ok = True

# --- media route: user visibility = assigned accounts only ---
ok &= edit(
    r"C:\Users\ankit\x_panel\app\api\media\route.ts",
    """  // users: shared approved accounts
  const shared = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.status, "approved"), eq(accounts.enabled, 1)));
  const sharedIds = shared.map((a) => a.id);""",
    """  // users: ONLY the accounts the admin assigned to them (private per user)
  const assigned = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.status, "approved"),
        eq(accounts.enabled, 1)
      )
    );
  const sharedIds = assigned.map((a) => a.id);""",
    "media-get-assigned",
)

# --- media route: uploads must target an account assigned to the user ---
ok &= edit(
    r"C:\Users\ankit\x_panel\app\api\media\route.ts",
    """  const accountId = String(form.get("accountId") || "").trim();
  // non-admin uploads must target a shared account they can post to
  if (user.role !== "admin" && accountId) {
    const acct = (
      await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
    )[0];
    if (!acct || acct.status !== "approved" || acct.enabled !== 1) {
      return NextResponse.json({ error: "That account is not available" }, { status: 403 });
    }
  }""",
    """  const accountId = String(form.get("accountId") || "").trim();
  // non-admin uploads must target an account assigned to them
  if (user.role !== "admin" && accountId) {
    const acct = (
      await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
    )[0];
    if (
      !acct ||
      acct.userId !== user.id ||
      acct.status !== "approved" ||
      acct.enabled !== 1
    ) {
      return NextResponse.json({ error: "That account is not available" }, { status: 403 });
    }
  }""",
    "media-upload-assigned",
)

# --- accounts/[id] route: assign-to-user action ---
ok &= edit(
    r"C:\Users\ankit\x_panel\app\api\accounts\[id]\route.ts",
    """  if (action === "update") {""",
    """  if (action === "assign") {
    const target = String(body?.userId || "").trim();
    if (!target) return json({ error: "userId required (empty string = unassign to admin)" }, 400);
    await db.update(accounts).set({ userId: target }).where(eq(accounts.id, id));
    return json({ ok: true, assignedTo: target });
  }

  if (action === "update") {""",
    "accounts-assign-action",
)

sys.exit(0 if ok else 1)
