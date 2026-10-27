
const fs = require("fs");
const p = "app/api/worker/claim/route.ts";
let s = fs.readFileSync(p, "utf8");
if (!s.includes("safeParse")) {
  s = s.replace(
    '// Worker polls this to pick up the oldest queued job.',
    `// Worker polls this to pick up the oldest queued job.
// Safe JSON.parse — some accounts have empty/invalid oauth1_json; a raw
// JSON.parse("") throws and 500s the whole claim route, stalling ALL jobs.
function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}`
  );
  s = s.replace("sessionJson: JSON.parse(acct.sessionJson),", "sessionJson: safeParse(acct.sessionJson),");
  s = s.replace("oauth1Json: JSON.parse(acct.oauth1Json),", "oauth1Json: safeParse(acct.oauth1Json),");
  fs.writeFileSync(p, s);
  console.log("edited");
} else console.log("already patched");
