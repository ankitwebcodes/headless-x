// Add referrerPolicy="no-referrer" to all twimg media elements (twimg 403s
// cross-origin Referers — direct/no-referrer loads fine, 206 verified).
import { readFileSync, writeFileSync } from "node:fs";
for (const p of ["app/dashboard/page.tsx", "app/admin/page.tsx"]) {
  let s;
  try { s = readFileSync(p, "utf8"); } catch { continue; }
  let n = 0;
  s = s.replace(/<img (?!referrerPolicy)/g, () => { n++; return '<img referrerPolicy="no-referrer" '; });
  s = s.replace(/<video\n(\s+)/g, (mm, ind) => { n++; return `<video\n${ind}referrerPolicy="no-referrer"\n${ind}`; });
  writeFileSync(p, s);
  console.log(p, "patched:", n);
}