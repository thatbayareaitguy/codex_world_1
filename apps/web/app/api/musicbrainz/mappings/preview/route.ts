import { artistAliases, artistExternalIds, artistMappingReviews, artists } from "@radar/db";
import { scoreMusicBrainzArtist } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createMusicBrainzServerContext } from "../../../../../lib/musicbrainz-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const bodySchema = z.object({ artistId: z.uuid() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    const { artistId } = bodySchema.parse(await request.json());
    const context = await createMusicBrainzServerContext();
    try {
      const artist = await context.db.query.artists.findFirst({ where: eq(artists.id, artistId) });
      if (!artist) return NextResponse.json({ error: "Artist not found" }, { status: 404 });
      const aliasRows = await context.db.query.artistAliases.findMany({
        where: eq(artistAliases.artistId, artistId),
      });
      const currentMapping = await context.db.query.artistExternalIds.findFirst({
        where: and(
          eq(artistExternalIds.artistId, artistId),
          eq(artistExternalIds.provider, "musicbrainz"),
          eq(artistExternalIds.confirmed, true),
        ),
      });
      const aliases = aliasRows.map((alias) => alias.name);
      const results = (await context.client.searchArtists(artist.name, aliases)).map((result) => ({
        ...scoreMusicBrainzArtist(artist.name, aliases, result),
        disambiguation: result.disambiguation,
        id: result.id,
        name: result.name,
      }));
      const [best, second] = results;
      const automatic =
        best && best.confidence >= 0.97 && (!second || best.confidence - second.confidence >= 0.08);
      if (automatic && best) {
        const now = new Date();
        await context.db.transaction(async (tx) => {
          await tx
            .insert(artistExternalIds)
            .values({
              artistId,
              confirmed: true,
              externalId: best.id,
              confirmedAt: now,
              mappingSource: "musicbrainz_conservative_auto_match",
              matchReasons: best.reasons,
              matchScore: best.confidence.toFixed(3),
              provider: "musicbrainz",
              providerUrl: `https://musicbrainz.org/artist/${best.id}`,
            })
            .onConflictDoUpdate({
              target: [artistExternalIds.artistId, artistExternalIds.provider],
              set: {
                confirmed: true,
                confirmedAt: now,
                externalId: best.id,
                mappingSource: "musicbrainz_conservative_auto_match",
                matchReasons: best.reasons,
                matchScore: best.confidence.toFixed(3),
                providerUrl: `https://musicbrainz.org/artist/${best.id}`,
                updatedAt: now,
              },
            });
          await tx
            .update(artistMappingReviews)
            .set({ decidedAt: now, status: "rejected", updatedAt: now })
            .where(
              and(
                eq(artistMappingReviews.artistId, artistId),
                eq(artistMappingReviews.provider, "musicbrainz"),
              ),
            );
        });
        return NextResponse.json({ automatic: true, currentMapping: best.id, results });
      }
      for (const result of results.slice(0, 5)) {
        const currentlyConfirmed = currentMapping?.externalId === result.id;
        await context.db
          .insert(artistMappingReviews)
          .values({
            artistId,
            decidedAt: currentlyConfirmed ? (currentMapping.confirmedAt ?? new Date()) : null,
            matchReasons: result.reasons,
            matchScore: result.confidence.toFixed(3),
            proposedExternalId: result.id,
            provider: "musicbrainz",
            providerName: result.name,
            status: currentlyConfirmed ? "confirmed" : "pending",
          })
          .onConflictDoUpdate({
            target: [
              artistMappingReviews.artistId,
              artistMappingReviews.provider,
              artistMappingReviews.proposedExternalId,
            ],
            set: {
              matchReasons: result.reasons,
              matchScore: result.confidence.toFixed(3),
              providerName: result.name,
              decidedAt: currentlyConfirmed ? (currentMapping.confirmedAt ?? new Date()) : null,
              status: currentlyConfirmed ? "confirmed" : "pending",
              updatedAt: new Date(),
            },
          });
      }
      return NextResponse.json({
        automatic: false,
        currentMapping: currentMapping?.externalId ?? null,
        results,
      });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to preview MusicBrainz mappings" }, { status: 400 });
  }
}
