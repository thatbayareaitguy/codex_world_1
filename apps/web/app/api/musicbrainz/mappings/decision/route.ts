import { artistExternalIds, artistMappingReviews } from "@radar/db";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createMusicBrainzServerContext } from "../../../../../lib/musicbrainz-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const bodySchema = z.object({ decision: z.enum(["confirm", "reject"]), reviewId: z.uuid() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20);
    const body = bodySchema.parse(await request.json());
    const context = await createMusicBrainzServerContext();
    try {
      const review = await context.db.query.artistMappingReviews.findFirst({
        where: and(
          eq(artistMappingReviews.id, body.reviewId),
          eq(artistMappingReviews.provider, "musicbrainz"),
        ),
      });
      if (!review) return NextResponse.json({ error: "Mapping review not found" }, { status: 404 });
      if (body.decision === "confirm") {
        await context.db
          .insert(artistExternalIds)
          .values({
            artistId: review.artistId,
            confirmed: true,
            confirmedAt: new Date(),
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
              confirmedAt: new Date(),
              externalId: review.proposedExternalId,
              mappingSource: "user_confirmed_musicbrainz",
              updatedAt: new Date(),
            },
          });
      }
      await context.db
        .update(artistMappingReviews)
        .set({
          decidedAt: new Date(),
          status: body.decision === "confirm" ? "confirmed" : "rejected",
        })
        .where(eq(artistMappingReviews.id, review.id));
      return NextResponse.json({ decision: body.decision });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to save MusicBrainz mapping decision" },
      { status: 400 },
    );
  }
}
