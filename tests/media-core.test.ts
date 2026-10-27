import { test } from "node:test";
import { strict as assert } from "node:assert";
import { belongsToAccount, mediaTypeFilter, tweetCaption } from "../lib/media-policy.ts";

test("media visibility is isolated by account for synced and uploaded items", () => {
  const syncedA = { id: "synced-a", accountId: "account-a" };
  const uploadedA = { id: "upload-a", accountId: null };
  const syncedB = { id: "synced-b", accountId: "account-b" };
  const memberships = [{ mediaId: "upload-a", accountId: "account-a" }];

  assert.equal(belongsToAccount(syncedA, "account-a", memberships), true);
  assert.equal(belongsToAccount(uploadedA, "account-a", memberships), true);
  assert.equal(belongsToAccount(syncedB, "account-a", memberships), false);
  assert.equal(belongsToAccount(uploadedA, "account-b", memberships), false);
});

test("caption formatting never adds a destination URL", () => {
  assert.equal(tweetCaption("  My video caption  "), "My video caption");
  assert.equal(tweetCaption(""), "");
});

test("media library lists only actual videos", () => {
  const items = [
    { id: "video", mediaType: "VIDEO" },
    { id: "image", mediaType: "IMAGE" },
    { id: "upload", mediaType: null },
  ];
  assert.deepEqual(mediaTypeFilter(items).map((item) => item.id), ["video"]);
});