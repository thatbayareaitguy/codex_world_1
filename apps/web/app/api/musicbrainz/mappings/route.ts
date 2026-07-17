import { artistExternalIds, artistMappingReviews, artists } from "@radar/db";
import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createMusicBrainzServerContext } from "../../../../lib/musicbrainz-server";
import { enforceRateLimit } from "../../../../lib/request-security";

const querySchema = z.object({ artistId: z.uuid().optional() });

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, 60);
    const artistIdValue = request.nextUrl.searchParams.get("artistId") ?? undefined;
    const { artistId } = querySchema.parse({ artistId: artistIdValue });
    const context = await createMusicBrainzServerContext();
    try {
      const reviews = await context.db
        .select({
          artistId: artistMappingReviews.artistId,
          artistName: artists.name,
          confidence: artistMappingReviews.matchScore,
          createdAt: artistMappingReviews.createdAt,
          id: artistMappingReviews.id,
          name: artistMappingReviews.providerName,
          proposedExternalId: artistMappingReviews.proposedExternalId,
          reasons: artistMappingReviews.matchReasons,
          status: artistMappingReviews.status,
        })
        .from(artistMappingReviews)
        .innerJoin(artists, eq(artists.id, artistMappingReviews.artistId))
        .where(
          and(
            eq(artistMappingReviews.provider, "musicbrainz"),
            ...(artistId ? [eq(artistMappingReviews.artistId, artistId)] : []),
          ),
        )
        .orderBy(desc(artistMappingReviews.updatedAt));
      const mappings = await context.db
        .select({
          artistId: artistExternalIds.artistId,
          artistName: artists.name,
          confidence: artistExternalIds.matchScore,
          externalId: artistExternalIds.externalId,
          reasons: artistExternalIds.matchReasons,
          url: artistExternalIds.providerUrl,
        })
        .from(artistExternalIds)
        .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
        .where(
          and(
            eq(artistExternalIds.provider, "musicbrainz"),
            eq(artistExternalIds.confirmed, true),
            ...(artistId ? [eq(artistExternalIds.artistId, artistId)] : []),
          ),
        );
      return NextResponse.json({ mappings, reviews });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to load MusicBrainz mappings" }, { status: 400 });
  }
}
