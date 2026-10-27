// Fix mediaIdFromKey to handle gm_ keys (cookie-synced media tab items).
import { readFileSync, writeFileSync } from "node:fs";
const p = new URL("../lib/xpost.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let s = readFileSync(p, "utf8");
const before = "const m = String(key).match(/^\\d+_(\\d+)/);";
const after = 'const m = String(key).match(/^(?:\\d+|gm)_(\\d+)/); // gm_ = cookie-synced media tab items';
if (!s.includes(before)) {
  console.log("PATTERN NOT FOUND — dumping current fn:");
  console.log(s.slice(s.indexOf("export function mediaIdFromKey"), s.indexOf("export function mediaIdFromKey") + 220));
  process.exit(1);
}
s = s.replace(before, after);
writeFileSync(p, s);
console.log("gm_ regex applied:", s.includes("gm)_(\\d+)"));