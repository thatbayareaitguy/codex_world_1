import { spotifyTrackIdFromUrl } from "@radar/core";
import {
  artistExternalIds,
  createDatabase,
  feedItems,
  queueSpotifyTrackResolutionWork,
  trackCredits,
  tracks,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { and, asc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const requestSchema = z.object({ url: z.string().min(1).max(500) });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20, 60_000, "/api/feed-items/spotify-link");
    const { url } = requestSchema.parse(await request.json());
    const spotifyTrackId = spotifyTrackIdFromUrl(url);
    if (!spotifyTrackId) {
      return NextResponse.json({ error: "Enter a valid Spotify track URL" }, { status: 400 });
    }
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Spotify resolution is not enabled" }, { status: 503 });
    }

    const { id } = await context.params;
    const connection = createDatabase(configuration.databaseUrl);
    try {
      const [target] = await connection.db
        .select({
          artistId: trackCredits.artistId,
          isrc: tracks.isrc,
          spotifyArtistId: artistExternalIds.externalId,
          trackId: tracks.id,
        })
        .from(feedItems)
        .innerJoin(tracks, eq(tracks.id, feedItems.trackId))
        .innerJoin(trackCredits, eq(trackCredits.trackId, tracks.id))
        .innerJoin(
          artistExternalIds,
          and(
            eq(artistExternalIds.artistId, trackCredits.artistId),
            eq(artistExternalIds.provider, "spotify"),
            eq(artistExternalIds.confirmed, true),
          ),
        )
        .where(eq(feedItems.id, id))
        .orderBy(asc(trackCredits.creditOrder))
        .limit(1);
      if (!target) {
        return NextResponse.json(
          { error: "This feed item has no confirmed Spotify artist mapping" },
          { status: 409 },
        );
      }
      if (!target.isrc) {
        return NextResponse.json(
          { error: "This feed item has no ISRC for exact verification" },
          { status: 409 },
        );
      }
      await queueSpotifyTrackResolutionWork(connection.db, {
        artistId: target.artistId,
        expectedSpotifyArtistId: target.spotifyArtistId,
        mode: "manual",
        source: "repair",
        spotifyTrackId,
        targetIsrc: target.isrc,
        targetTrackId: target.trackId,
      });
      return NextResponse.json({ status: "queued" }, { status: 202 });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to queue Spotify link verification" },
      { status: 400 },
    );
  }
}
