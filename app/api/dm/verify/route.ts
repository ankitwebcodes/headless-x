import {getUser,json} from "@/lib/reqAuth";
import {auditDmReposts} from "@/lib/dm-run";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(req:Request){
  const user=await getUser(req);if(!user)return json({ok:false,error:"Unauthorized"},401);
  try{const body=await req.json();return json({ok:true,...await auditDmReposts(user.id,String(body.id??""),body.force===true)})}
  catch(e){return json({ok:false,error:(e as Error).message},409)}
}
