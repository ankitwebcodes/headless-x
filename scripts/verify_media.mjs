// Verify media rows: count per account + gm_ rows + sample names.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const DSN = (m.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || m.match(/DATABASE_URL\s*=\s*(\S+)/))[1];
const db = neon(DSN);

const rows = await db`
  select a.handle, count(*)::int as n,
         count(*) filter (where md.media_key like 'gm_%')::int as gm_n,
         count(*) filter (where md.media_type = 'VIDEO')::int as vids,
         count(*) filter (where md.media_type = 'IMAGE')::int as imgs,
         count(*) filter (where md.media_type is null)::int as nulls
  from media md join accounts a on a.id = md.account_id
  group by a.handle order by n desc`;
console.log(rows);

const s = await db`select name, media_type, left(url, 60) as url from media md
  join accounts a on a.id = md.account_id
  where a.handle ilike '%guysexhibition%' order by md.created_at desc limit 5`;
console.log(s);