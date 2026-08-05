import {
  artistExternalIds,
  artists,
  listArtistMappingReviewArtistsPage,
  listArtistMappingReviewsPage,
} from "@radar/db";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProviderDatabaseServerContext } from "../../../../lib/provider-database-server";
import { enforceRateLimit } from "../../../../lib/request-security";

const querySchema = z.object({
  artistId: z.uuid().optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(5).max(50).default(20),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, 60);
    const { artistId, cursor, limit } = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const context = await createProviderDatabaseServerContext();
    try {
      const reviewPage = artistId
        ? await listArtistMappingReviewsPage(context.db, {
            artistId,
            ...(cursor ? { cursor } : {}),
            limit,
            provider: "apple_music",
          })
        : await listArtistMappingReviewArtistsPage(context.db, {
            ...(cursor ? { cursor } : {}),
            limit,
            provider: "apple_music",
          });
      const mappings = artistId
        ? await context.db
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
                eq(artistExternalIds.provider, "apple_music"),
                eq(artistExternalIds.confirmed, true),
                eq(artistExternalIds.artistId, artistId),
              ),
            )
        : [];
      return NextResponse.json({ mappings, ...reviewPage });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to load Apple Music mappings" }, { status: 400 });
  }
}
