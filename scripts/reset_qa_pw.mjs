import fs from "fs";
import bcrypt from "bcryptjs";
import { neon } from "@neondatabase/serverless";

const url = fs.readFileSync("C:/Users/ankit/dburl.txt", "utf8").trim();
if (!url.startsWith("postgres")) {
  console.log("NO_DB_URL");
  process.exit(1);
}
const sql = neon(url);
const h = bcrypt.hashSync(process.argv[2] || "Xp-Qa-2026-Admin!", 10);
const rows = await sql`UPDATE users SET password_hash=${h} WHERE email='qa-e2e-admin@pinelab.org' RETURNING id, email`;
console.log("updated rows:", rows.length, rows[0]?.email ?? "(none)");