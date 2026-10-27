import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

// Production: Neon Postgres (DATABASE_URL / POSTGRES_URL set by Vercel).
// Local dev:  same Postgres — `vercel env pull` to get DATABASE_URL.
const connectionString =
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL/POSTGRES_URL not set — using a placeholder. " +
      "Set it (vercel env pull) before running queries."
  );
}
const client = neon(connectionString || "postgres://x:x@localhost:5432/x");

export const db = drizzle(client, { schema });

// DDL for the 4 tables (idempotent; runs on first request after deploy).
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    session_json TEXT NOT NULL,
    oauth1_json TEXT NOT NULL,
    ads_account_id TEXT NOT NULL,
    default_url TEXT NOT NULL,
    default_title TEXT NOT NULL,
    default_caption TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS enabled INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    duration_ms INTEGER,
    created_at BIGINT NOT NULL
  )`,
  // media-library sync columns (idempotent for existing DBs)
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS media_key TEXT`,
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS account_id TEXT`,
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS media_type TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_media_media_key ON media(media_key)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    caption TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    tweet_url TEXT,
    error TEXT,
    claimed_by TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pc_control (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  // card cache: card per (source media key, destination link) — the first
  // post of a video+link pays upload+card creation, every repeat is instant
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    media_key TEXT NOT NULL,
    link TEXT NOT NULL,
    card_uri TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_media_link ON cards(media_key, link)`,
  // ads-library upload cache: uploaded media id per (source media, ads account)
  `CREATE TABLE IF NOT EXISTS ads_media (
    id TEXT PRIMARY KEY,
    media_key TEXT NOT NULL,
    ads_account_id TEXT NOT NULL,
    ads_media_id TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_media_key_acct ON ads_media(media_key, ads_account_id)`,
  // per-account media library cache: key per (source media, destination account)
  `CREATE TABLE IF NOT EXISTS account_media (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    media_key TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_media_am_idx ON account_media(account_id, media_id)`,
];

let initPromise: Promise<void> | null = null;

/** Ensure tables exist. Memoized; safe to await from every handler. */
export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      for (const stmt of DDL) {
        await db.execute(sql.raw(stmt));
      }
    })().catch((e) => {
      initPromise = null; // allow retry on next call
      throw e;
    });
  }
  return initPromise;
}