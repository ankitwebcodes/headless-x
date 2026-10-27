// Route ALL media rendering through the panel proxy (twimg 403s cross-origin
// Referers; Chromium media loads ignore referrerpolicy — verified live).
import { readFileSync, writeFileSync } from "node:fs";
const p = new URL("../app/dashboard/page.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let s = readFileSync(p, "utf8");

// helper next to other top-level helpers
if (!s.includes("function prox(")) {
  s = s.replace(
    "function VideoThumb(",
    `function prox(u: string): string {\n  return \`/api/proxy-media?u=\${encodeURIComponent(u)}\`;\n}\n\nfunction VideoThumb(`
  );
}

s = s.replaceAll("src={picked.url}", "src={prox(picked.url)}");
s = s.replaceAll("src={m.url}", "src={prox(m.url)}");
s = s.replaceAll("<VideoThumb url={picked.url}", "<VideoThumb url={prox(picked.url)}");
s = s.replaceAll("<VideoThumb url={m.url}", "<VideoThumb url={prox(m.url)}");

writeFileSync(p, s);
console.log({ prox: s.includes("function prox("), img: s.includes("src={prox("), thumb: s.includes("url={prox(") });