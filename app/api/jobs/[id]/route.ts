import { db, initDb } from "@/lib/db";
import { jobs } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { json } from "@/lib/reqAuth";

// Worker bridge: mark job processing (status + claimed_by)
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await initDb();
  const auth = req.headers.get("x-worker-token");
  if (auth !== process.env.WORKER_TOKEN) return json({ error: "Unauthorized" }, 401);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const job = (
    await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
  )[0];
  if (!job) return json({ error: "Job not found" }, 404);

  const action = body?.action;
  if (action === "start") {
    await db
      .update(jobs)
      .set({ status: "processing", claimedBy: body?.worker ?? "worker", updatedAt: Date.now() })
      .where(eq(jobs.id, id));
    return json({ ok: true, status: "processing" });
  }
  if (action === "done") {
    await db
      .update(jobs)
      .set({
        status: "done",
        tweetUrl: body?.tweetUrl ?? job.tweetUrl,
        error: null,
        updatedAt: Date.now(),
      })
      .where(eq(jobs.id, id));
    return json({ ok: true, status: "done" });
  }
  if (action === "fail") {
    await db
      .update(jobs)
      .set({
        status: "failed",
        error: String(body?.error ?? "unknown error").slice(0, 1000),
        updatedAt: Date.now(),
      })
      .where(eq(jobs.id, id));
    return json({ ok: true, status: "failed" });
  }
  return json({ error: "action must be start | done | fail" }, 400);
}