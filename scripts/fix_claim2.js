
const fs = require("fs");
const p = "app/api/worker/claim/route.ts";
let s = fs.readFileSync(p, "utf8");
if (!s.includes("proxy-media")) {
  s = s.replace(
    "      mediaUrl: med.url,",
    `      // Private blob URLs 403 for direct fetches — route through the
      // presigned proxy instead (twimg URLs pass through unchanged).
      mediaUrl: med.url.includes("vercel-storage.com")
        ? \`/api/proxy-media?u=\${encodeURIComponent(med.url)}\`
        : med.url,`
  );
  fs.writeFileSync(p, s);
  console.log("edited");
} else console.log("already patched");
