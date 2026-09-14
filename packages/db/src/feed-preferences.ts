import { and, eq, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { feedItems } from "./schema";

export interface FeedPreferenceUpdate {
  listened?: boolean;
  saved?: boolean;
}

export async function updateFeedPreferences(
  db: RadarDatabase,
  userId: string,
  feedItemId: string,
  input: FeedPreferenceUpdate,
  now = new Date(),
) {
  if (input.saved === undefined && input.listened === undefined) {
    throw new Error("A saved or listened preference is required");
  }

  const [updated] = await db
    .update(feedItems)
    .set({
      ...(input.saved !== undefined ? { savedAt: input.saved ? now : null } : {}),
      ...(input.listened !== undefined ? { listenedAt: input.listened ? now : null } : {}),
      state: sql`case when ${feedItems.state} in ('saved', 'listened') then 'new'::feed_state else ${feedItems.state} end`,
      updatedAt: now,
    })
    .where(and(eq(feedItems.id, feedItemId), eq(feedItems.userId, userId)))
    .returning({
      id: feedItems.id,
      listenedAt: feedItems.listenedAt,
      savedAt: feedItems.savedAt,
      state: feedItems.state,
    });

  if (!updated) return undefined;
  return {
    id: updated.id,
    listened: updated.listenedAt !== null,
    saved: updated.savedAt !== null,
    state: updated.state,
  };
}
