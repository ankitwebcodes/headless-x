export function mediaTypeFilter(items, videosOnly = true) {
  if (!videosOnly) return items;
  return items.filter((item) => item.mediaType === "VIDEO");
}

export function belongsToAccount(item, accountId, memberships = []) {
  return item.accountId === accountId || memberships.some(
    (membership) => membership.mediaId === item.id && membership.accountId === accountId,
  );
}

/** Website destinations are cards, never part of the tweet caption. */
export function tweetCaption(caption) {
  return caption.trim();
}
