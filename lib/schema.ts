import { pgTable, text, integer, bigint, uniqueIndex } from "drizzle-orm/pg-core";

// Users: admin + creators
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// X accounts a user connects (cookies + oauth1 + ads account id)
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  handle: text("handle").notNull(),
  // cookie/session json (encrypted string) — needed by worker to post
  sessionJson: text("session_json").notNull(),
  // OAuth1 creds json (consumer key/secret + token/secret)
  oauth1Json: text("oauth1_json").notNull(),
  adsAccountId: text("ads_account_id").notNull(),
  defaultUrl: text("default_url").notNull(),
  defaultTitle: text("default_title").notNull(),
  defaultCaption: text("default_caption"),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  enabled: integer("enabled").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Media library (synced videos)
export const media = pgTable("media", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(), // blob url OR ads-api pbs.twimg media url
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  mimeType: text("mime_type").notNull(),
  durationMs: integer("duration_ms"),
  // ads-api media library sync fields
  mediaKey: text("media_key"), // e.g. 13_2105870157872525312
  accountId: text("account_id"), // accounts.id it was synced from
  mediaType: text("media_type"), // VIDEO / IMAGE (ads-api)
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Post jobs: queued -> claimed/processing -> done / failed
export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull(),
  mediaId: text("media_id").notNull(),
  caption: text("caption").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  status: text("status", {
    enum: ["queued", "processing", "done", "failed"],
  })
    .notNull()
    .default("queued"),
  tweetUrl: text("tweet_url"),
  error: text("error"),
  claimedBy: text("claimed_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
// Per-account media keys: media keys are per-account in X, so a video
// uploaded from the panel gets pushed into EACH target account's real X
// media library. Post routes resolve the key per (account, media) first.
export const accountMedia = pgTable(
  "account_media",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull(),
    accountId: text("account_id").notNull(),
    mediaKey: text("media_key"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({ amIdx: uniqueIndex("account_media_am_idx").on(t.accountId, t.mediaId) })
);
