import {getUser,json} from "@/lib/reqAuth";
import {manageDmHistory,clearDmData} from "@/lib/dm-history";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(req:Request) {
  const user=await getUser(req);
  if(!user)return json({ok:false,error:"Unauthorized"},401);
  try{
    const body=await req.json();
    const id=String(body.id??"");
    const allAccounts=body.allAccounts===true;
    if(body.mode==="full"){
      const result=await clearDmData(user.id,{id,allAccounts,includeScans:body.includeScans!==false,confirm:body.confirm===true});
      return json({ok:true,...result});
    }
    const result=await manageDmHistory(user.id,{id,allAccounts,before:body.before,confirm:body.confirm===true});
    return json({ok:true,...result});
  }catch(e){return json({ok:false,error:(e as Error).message},409)}
}
