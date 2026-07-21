import { trackCandidateSchema } from "@radar/providers";
import { and, eq, ne } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  feedItems,
  manualMatchDecisions,
  releaseCandidates,
  trackAvailabilities,
  trackExternalIds,
} from "./schema";

export type FeedReviewDecision = "confirm" | "separate";

export interface FeedReviewResolution {
  decision: FeedReviewDecision;
  feedItemId: string;
  removed: boolean;
  state: "dismissed" | "new";
}

export async function resolveFeedReview(
  db: RadarDatabase,
  userId: string,
  feedItemId: string,
  decision: FeedReviewDecision,
  now = new Date(),
): Promise<FeedReviewResolution | undefined> {
  return db.transaction(async (tx) => {
    const feed = await tx.query.feedItems.findFirst({
      where: and(eq(feedItems.id, feedItemId), eq(feedItems.userId, userId)),
    });
    if (!feed?.candidateId) return undefined;

    const candidate = await tx.query.releaseCandidates.findFirst({
      where: eq(releaseCandidates.id, feed.candidateId),
    });
    if (!candidate || candidate.matchStatus !== "needs_review") return undefined;

    if (decision === "confirm") {
      if (!candidate.matchedTrackId) {
        throw new Error("Review candidate has no proposed canonical track");
      }
      const payload = trackCandidateSchema.parse(candidate.rawPayload);
      await upsertDecision(
        tx,
        candidate.id,
        userId,
        "confirm",
        candidate.matchedTrackId,
        "Manually confirmed match",
        now,
      );
      await tx
        .update(releaseCandidates)
        .set({
          matchConfidence: "1.000",
          matchReasons: ["Manually confirmed match"],
          matchRule: "manual_confirmation",
          matchStatus: "matched",
        })
        .where(eq(releaseCandidates.id, candidate.id));

      await tx
        .insert(trackExternalIds)
        .values({
          externalId: candidate.providerTrackId,
          provider: candidate.provider,
          providerFields: { availability: payload.availability },
          providerUrl: payload.providerUrl,
          trackId: candidate.matchedTrackId,
        })
        .onConflictDoNothing();
      await tx
        .insert(trackAvailabilities)
        .values({
          checkedAt: now,
          provider: candidate.provider,
          providerTrackId: candidate.providerTrackId,
          providerUrl: payload.providerUrl,
          region: payload.region,
          state: payload.availability,
          trackId: candidate.matchedTrackId,
        })
        .onConflictDoNothing();

      const existingCanonicalFeed = await tx.query.feedItems.findFirst({
        columns: { id: true },
        where: and(
          eq(feedItems.userId, userId),
          eq(feedItems.trackId, candidate.matchedTrackId),
          ne(feedItems.id, feedItemId),
          ne(feedItems.state, "needs_review"),
        ),
      });
      if (existingCanonicalFeed) {
        await tx.delete(feedItems).where(eq(feedItems.id, feedItemId));
        await tx
          .update(feedItems)
          .set({ updatedAt: now })
          .where(eq(feedItems.id, existingCanonicalFeed.id));
        return { decision, feedItemId, removed: true, state: "new" };
      }

      await tx
        .update(feedItems)
        .set({ state: "new", updatedAt: now })
        .where(eq(feedItems.id, feedItemId));
      return { decision, feedItemId, removed: false, state: "new" };
    }

    await upsertDecision(
      tx,
      candidate.id,
      userId,
      "separate",
      candidate.matchedTrackId,
      "Manually rejected proposed match",
      now,
    );
    await tx
      .update(releaseCandidates)
      .set({
        matchedTrackId: null,
        matchReasons: ["Manually rejected proposed match"],
        matchRule: "manual_separate",
        matchStatus: "rejected",
      })
      .where(eq(releaseCandidates.id, candidate.id));
    await tx.delete(feedItems).where(eq(feedItems.id, feedItemId));
    return { decision, feedItemId, removed: true, state: "dismissed" };
  });
}

type ReviewTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];

async function upsertDecision(
  tx: ReviewTransaction,
  candidateId: string,
  userId: string,
  decision: FeedReviewDecision,
  selectedTrackId: string | null,
  reason: string,
  decidedAt: Date,
) {
  await tx
    .insert(manualMatchDecisions)
    .values({ candidateId, decidedAt, decision, reason, selectedTrackId, userId })
    .onConflictDoUpdate({
      target: manualMatchDecisions.candidateId,
      set: { decidedAt, decision, reason, selectedTrackId, userId },
    });
}
