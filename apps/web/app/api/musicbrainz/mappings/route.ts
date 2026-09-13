import {
  artistExternalIds,
  artists,
  listArtistMappingReviewArtistsPage,
  listMusicBrainzMappingReviewsPage,
} from "@radar/db";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createMusicBrainzServerContext } from "../../../../lib/musicbrainz-server";
import { musicBrainzDisabledResponse } from "../../../../lib/musicbrainz-feature";
import { enforceRateLimit } from "../../../../lib/request-security";

const querySchema = z.object({
  artistId: z.uuid().optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(5).max(50).default(20),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const disabled = musicBrainzDisabledResponse();
  if (disabled) return disabled;
  try {
    enforceRateLimit(request, 60);
    const { artistId, cursor, limit } = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const context = await createMusicBrainzServerContext();
    try {
      const reviewPage = artistId
        ? await listMusicBrainzMappingReviewsPage(context.db, {
            artistId,
            ...(cursor ? { cursor } : {}),
            limit,
          })
        : await listArtistMappingReviewArtistsPage(context.db, {
            ...(cursor ? { cursor } : {}),
            limit,
            provider: "musicbrainz",
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
                eq(artistExternalIds.provider, "musicbrainz"),
                eq(artistExternalIds.confirmed, true),
                ...(artistId ? [eq(artistExternalIds.artistId, artistId)] : []),
              ),
            )
        : [];
      return NextResponse.json({ mappings, ...reviewPage });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to load MusicBrainz mappings" }, { status: 400 });
  }
}
