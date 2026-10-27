import {tweetIdFromUrl,type DmIncomingMessage,type DmOutcome} from "./dm-core.ts";
const cache=new Map<string,{id:string;until:number}>();
const allowed=(url:URL)=>url.protocol==="https:"&&!url.username&&!url.password&&(!url.port||url.port==="443")&&/^(?:t\.co|(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com))$/i.test(url.hostname);
export async function resolveDmPost(message:DmIncomingMessage,signal?:AbortSignal):Promise<DmOutcome&{tweetId?:string}> {
  if(message.tweetIds.length)return {ok:true,tweetId:message.tweetIds.at(-1)};
  for(const raw of [...(message.postUrls??[])].slice(-8).reverse()){
    let url:URL;try{url=new URL(raw)}catch{continue}
    if(!allowed(url))continue;
    const existing=cache.get(url.href);if(existing&&existing.until>Date.now())return {ok:true,tweetId:existing.id};
    const original=url.href;
    for(let hop=0;hop<4;hop++){
      const id=tweetIdFromUrl(url.href);if(id){if(cache.size>=1000)cache.delete(cache.keys().next().value!);cache.set(original,{id,until:Date.now()+600000});return {ok:true,tweetId:id}}
      if(url.hostname!=="t.co")break;
      try{
        const response=await fetch(url.href,{method:"GET",redirect:"manual",cache:"no-store",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(6000)]):AbortSignal.timeout(6000)});
        if(response.status===429)return {ok:false,kind:"rate_limit",error:"X short-link resolution is rate limited. Repost and DM remain blocked.",retryAt:Date.now()+60000};
        const location=response.headers.get("location");
        if(!location){await response.body?.cancel();return {ok:false,kind:"transient",error:"The message's shortened post link could not be resolved. Repost and DM remain blocked."}}
        await response.body?.cancel();const next=new URL(location,url);
        if(!allowed(next))break;
        url=next;
      }catch{return {ok:false,kind:"transient",error:"Could not resolve the received post link. No repost or reply was attempted."}}
    }
  }
  if(message.postCard)return {ok:false,kind:"transient",error:"The received post card did not expose a reliable post ID. Repost and DM remain blocked."};
  return {ok:true};
}
