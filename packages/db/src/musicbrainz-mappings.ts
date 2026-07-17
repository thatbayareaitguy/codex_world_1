import { and, eq, ne } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { artistExternalIds, artistMappingReviews } from "./schema";

export class MusicBrainzMappingReviewNotFoundError extends Error {
  constructor() {
    super("MusicBrainz mapping review not found.");
    this.name = "MusicBrainzMappingReviewNotFoundError";
  }
}

export async function decideMusicBrainzArtistMapping(
  db: RadarDatabase,
  input: { decision: "confirm" | "reject"; reviewId: string },
): Promise<{
  artistId: string;
  decision: "confirm" | "reject";
  externalId: string | null;
  idempotent: boolean;
}> {
  return db.transaction(async (tx) => {
    const review = await tx.query.artistMappingReviews.findFirst({
      where: and(
        eq(artistMappingReviews.id, input.reviewId),
        eq(artistMappingReviews.provider, "musicbrainz"),
      ),
    });
    if (!review) throw new MusicBrainzMappingReviewNotFoundError();

    const now = new Date();
    if (input.decision === "reject") {
      const idempotent = review.status === "rejected";
      await tx
        .update(artistMappingReviews)
        .set({
          decidedAt: review.decidedAt ?? now,
          status: "rejected",
          updatedAt: now,
        })
        .where(eq(artistMappingReviews.id, review.id));
      return { artistId: review.artistId, decision: "reject", externalId: null, idempotent };
    }

    const current = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.artistId, review.artistId),
        eq(artistExternalIds.provider, "musicbrainz"),
      ),
    });
    const idempotent =
      current?.confirmed === true && current.externalId === review.proposedExternalId;
    const confirmedAt = idempotent && current.confirmedAt ? current.confirmedAt : now;

    await tx
      .insert(artistExternalIds)
      .values({
        artistId: review.artistId,
        confirmed: true,
        confirmedAt,
        externalId: review.proposedExternalId,
        mappingSource: "user_confirmed_musicbrainz",
        matchReasons: review.matchReasons,
        matchScore: review.matchScore,
        provider: "musicbrainz",
        providerUrl: `https://musicbrainz.org/artist/${review.proposedExternalId}`,
      })
      .onConflictDoUpdate({
        target: [artistExternalIds.artistId, artistExternalIds.provider],
        set: {
          confirmed: true,
          confirmedAt,
          externalId: review.proposedExternalId,
          mappingSource: "user_confirmed_musicbrainz",
          matchReasons: review.matchReasons,
          matchScore: review.matchScore,
          providerUrl: `https://musicbrainz.org/artist/${review.proposedExternalId}`,
          updatedAt: now,
        },
      });
    await tx
      .update(artistMappingReviews)
      .set({ decidedAt: now, status: "rejected", updatedAt: now })
      .where(
        and(
          eq(artistMappingReviews.artistId, review.artistId),
          eq(artistMappingReviews.provider, "musicbrainz"),
          ne(artistMappingReviews.id, review.id),
        ),
      );
    await tx
      .update(artistMappingReviews)
      .set({
        decidedAt: idempotent && review.decidedAt ? review.decidedAt : now,
        status: "confirmed",
        updatedAt: now,
      })
      .where(eq(artistMappingReviews.id, review.id));

    return {
      artistId: review.artistId,
      decision: "confirm",
      externalId: review.proposedExternalId,
      idempotent,
    };
  });
}
