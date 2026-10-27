// Fix test_post_gm.mjs: r.text is a string + use proven all-chunks qid extraction.
import { readFileSync, writeFileSync } from "node:fs";

const p = new URL("./test_post_gm.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let s = readFileSync(p, "utf8");

s = s.replaceAll("r.text()", "r.text").replaceAll("d.text()", "d.text");

const newFn = `async function qidFor(name, fallback) {
  try {
    const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": UA } });
    const html = await home.text();
    const urls = Array.from(new Set(html.match(/https:\\/\\/abs\\.twimg\\.com\\/responsive-web\\/client-web\\/[^"' ]+\\.js/g) ?? []));
    for (const u of urls) {
      const res = await fetch(u);
      if (!res.ok) continue;
      const js = await res.text();
      const mm = js.match(new RegExp('queryId:"([A-Za-z0-9_-]{10,30})",operationName:"' + name + '"')) ||
        js.match(new RegExp('operationName:"' + name + '",queryId:"([A-Za-z0-9_-]{10,30})"'));
      if (mm) return mm[1];
    }
  } catch {}
  return fallback;
}
`;

s = s.replace(/async function qidFor[\s\S]*?\n}\n/, newFn);
writeFileSync(p, s);
console.log("patched:", s.includes("for (const u of urls)"), "r.text-as-string:", !s.includes("r.text()"));