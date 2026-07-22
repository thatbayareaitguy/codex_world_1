import { and, desc, eq, lt, or } from "drizzle-orm";

import type { RadarDatabase } from "./client";
import { artistMappingReviews, artists } from "./schema";

export interface MusicBrainzMappingReviewPage {
  hasMore: boolean;
  nextCursor: string | null;
  reviews: Array<{
    artistId: string;
    artistName: string;
    confidence: string;
    createdAt: Date;
    id: string;
    name: string;
    proposedExternalId: string;
    reasons: string[];
    status: string;
    updatedAt: Date;
  }>;
}

export async function listMusicBrainzMappingReviewsPage(
  db: RadarDatabase,
  options: { artistId?: string; cursor?: string; limit?: number } = {},
): Promise<MusicBrainzMappingReviewPage> {
  const limit = Math.max(5, Math.min(Math.trunc(options.limit ?? 20), 50));
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await db
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
      updatedAt: artistMappingReviews.updatedAt,
    })
    .from(artistMappingReviews)
    .innerJoin(artists, eq(artists.id, artistMappingReviews.artistId))
    .where(
      and(
        eq(artistMappingReviews.provider, "musicbrainz"),
        ...(options.artistId ? [eq(artistMappingReviews.artistId, options.artistId)] : []),
        ...(!options.artistId ? [eq(artistMappingReviews.status, "pending")] : []),
        ...(cursor
          ? [
              or(
                lt(artistMappingReviews.updatedAt, cursor.updatedAt),
                and(
                  eq(artistMappingReviews.updatedAt, cursor.updatedAt),
                  lt(artistMappingReviews.id, cursor.id),
                ),
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(artistMappingReviews.updatedAt), desc(artistMappingReviews.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const reviews = rows.slice(0, limit);
  const last = reviews.at(-1);
  return {
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null,
    reviews,
  };
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ id, updatedAt: updatedAt.toISOString() })).toString(
    "base64url",
  );
}

function decodeCursor(value: string): { id: string; updatedAt: Date } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("MusicBrainz review cursor is malformed");
  }
  if (!isCursor(parsed) || !isUuid(parsed.id)) {
    throw new Error("MusicBrainz review cursor is malformed");
  }
  const updatedAt = new Date(parsed.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    throw new Error("MusicBrainz review cursor is malformed");
  }
  return { id: parsed.id, updatedAt };
}

function isCursor(value: unknown): value is { id: string; updatedAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
