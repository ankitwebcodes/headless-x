import { cookieHeader, indexOperationPairs } from "./dm-core.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const cache = new Map<string,string>();
let lastAttempt = 0, lastSuccess = 0;
let indexing: Promise<void> | undefined;

export function dmAssetUrls(html: string, base: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/https:\/\/abs\.twimg\.com\/[^"'\\\s<>]+\.js/g)) {
    try {
      const url = new URL(match[0],base);
      if (url.protocol === "https:" && url.hostname === "abs.twimg.com") urls.add(url.href);
    } catch { /* malformed asset reference */ }
  }
  // Main contains CreateRetweet. Fetch it before vendor/i18n so a slow page
  // or a large vendor bundle cannot consume the discovery deadline first.
  return [...urls].filter(u => !/\/(?:i18n\/|vendor\.)/.test(u))
    .sort((a,b) => Number(/\/main[.-]/.test(b)) - Number(/\/main[.-]/.test(a)));
}
export async function resolveDmOperation(op: string, session: unknown, force = false): Promise<string> {
  const override = process.env[`DM_QID_${op.toUpperCase()}`];
  if (override) return override;
  if (!force && cache.has(op) && Date.now() - lastSuccess < 30 * 60_000) return cache.get(op)!;
  if (indexing) { await indexing; return cache.get(op) ?? ""; }
  // A wave of post-specific failures must not scrape the client once per chat.
  if (Date.now() - lastAttempt < 30_000) return cache.get(op) ?? "";
  if (!indexing) {
    lastAttempt = Date.now();
    indexing = (async () => {
      const signal = AbortSignal.timeout(12_000);
      const queue: string[] = [], seen = new Set<string>();
      const push = (raw: string, base: string) => {
        try {
          const url = new URL(raw,base);
          if (url.protocol !== "https:" || url.hostname !== "abs.twimg.com" || !url.pathname.endsWith(".js") || seen.has(url.href)) return;
          seen.add(url.href); queue.push(url.href);
        } catch { /* malformed manifest */ }
      };
      for (const page of ["https://x.com/home","https://x.com/messages"]) {
        if (signal.aborted) break;
        try {
          const response = await fetch(page,{ headers: { cookie: cookieHeader(session),"user-agent": UA },signal,cache: "no-store" });
          if (!response.ok) continue;
          for (const url of dmAssetUrls(await response.text(),page)) push(url,page);
          if (queue.length) break;
        } catch { /* try the second page only if the first one failed */ }
      }
      let fetched = 0, found = 0;
      while (queue.length && !signal.aborted && fetched < 40) {
        const batch = queue.splice(0,4); fetched += batch.length;
        await Promise.allSettled(batch.map(async url => {
          const response = await fetch(url,{ signal,cache: "no-store",headers: { "user-agent": UA } });
          if (!response.ok) return;
          const js = await response.text();
          for (const [name,id] of Object.entries(indexOperationPairs(js))) { cache.set(name,id); found++; }
          for (const match of js.matchAll(/["'`]((?:\.\/)?assets\/[A-Za-z0-9_.-]+\.js)["'`]/g))
            push(match[1],url.includes("/assets/") ? new URL("../",url).href : url);
          for (const match of js.matchAll(/["'`](\.\/[A-Za-z0-9_.-]+\.js)["'`]/g)) push(match[1],url);
        }));
        if (cache.has(op)) break;
      }
      if (found) lastSuccess = Date.now();
    })().finally(() => { indexing = undefined; });
  }
  await indexing;
  return cache.get(op) ?? "";
}
