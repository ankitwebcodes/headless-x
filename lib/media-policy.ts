export type MediaScopeRow = {
  id: string;
  accountId: string | null;
};

export type MediaMembership = {
  mediaId: string;
  accountId: string;
};

export function mediaTypeFilter<T extends { mediaType: string | null }>(items: T[], videosOnly = true): T[] {
  if (!videosOnly) return items;
  return items.filter((item) => item.mediaType === "VIDEO");
}

/** True only when a media row belongs to this account directly or via upload mapping. */
export function belongsToAccount(
  item: MediaScopeRow,
  accountId: string,
  memberships: MediaMembership[] = [],
): boolean {
  return item.accountId === accountId || memberships.some(
    (membership) => membership.mediaId === item.id && membership.accountId === accountId,
  );
}

/** Website destinations are cards, never part of the tweet caption. */
export function tweetCaption(caption: string): string {
  return caption.trim();
}