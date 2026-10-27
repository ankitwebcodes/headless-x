import { getUser,json } from "@/lib/reqAuth";
import { getDmFleet,startDmFleet } from "@/lib/dm-fleet";
import { dmWorkerStatus } from "@/lib/dm-worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ok:false,error:"Unauthorized"},401);
  const [accounts,worker] = await Promise.all([getDmFleet(user.id),dmWorkerStatus()]);
  return json({ok:true,accounts,workerConfigured:worker.online,workerKind:worker.kind});
}
export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ok:false,error:"Unauthorized"},401);
  return json({ok:true,results:await startDmFleet(user.id),accounts:await getDmFleet(user.id)});
}
