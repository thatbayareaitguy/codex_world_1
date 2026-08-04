import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import type { ProviderName } from "@radar/core";
import type { RadarDatabase } from "./client";
import { artistExternalIds, artistMappingReviews, artists } from "./schema";

export class ArtistMappingReviewNotFoundError extends Error {
  constructor() {
    super("Artist mapping review not found.");
    this.name = "ArtistMappingReviewNotFoundError";
  }
}

export class ArtistMappingCandidateRequiredError extends Error {
  constructor() {
    super("A candidate-free review cannot be confirmed without a provider artist ID.");
    this.name = "ArtistMappingCandidateRequiredError";
  }
}

export class ArtistMappingExternalIdConflictError extends Error {
  constructor() {
    super("The provider artist ID is already mapped to another canonical artist.");
    this.name = "ArtistMappingExternalIdConflictError";
  }
}

export async function confirmArtistMappingExternalId(
  db: RadarDatabase,
  input: {
    artistId: string;
    externalId: string;
    provider: "apple_music" | "musicbrainz";
  },
): Promise<{ artistId: string; externalId: string; idempotent: boolean }> {
  return db.transaction(async (tx) => {
    const existingByProviderId = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.provider, input.provider),
        eq(artistExternalIds.externalId, input.externalId),
      ),
    });
    if (existingByProviderId && existingByProviderId.artistId !== input.artistId) {
      throw new ArtistMappingExternalIdConflictError();
    }
    const current = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.artistId, input.artistId),
        eq(artistExternalIds.provider, input.provider),
      ),
    });
    const idempotent = current?.confirmed === true && current.externalId === input.externalId;
    const now = new Date();
    await tx
      .insert(artistExternalIds)
      .values({
        artistId: input.artistId,
        confirmed: true,
        confirmedAt: current?.confirmedAt ?? now,
        externalId: input.externalId,
        mappingSource: `user_confirmed_${input.provider}`,
        matchReasons: ["User supplied the exact provider artist ID"],
        matchScore: "1.000",
        provider: input.provider,
        providerUrl: providerArtistUrl(input.provider, input.externalId),
      })
      .onConflictDoUpdate({
        target: [artistExternalIds.artistId, artistExternalIds.provider],
        set: {
          confirmed: true,
          confirmedAt: current?.confirmedAt ?? now,
          externalId: input.externalId,
          mappingSource: `user_confirmed_${input.provider}`,
          matchReasons: ["User supplied the exact provider artist ID"],
          matchScore: "1.000",
          providerUrl: providerArtistUrl(input.provider, input.externalId),
          updatedAt: now,
        },
      });
    await tx
      .update(artistMappingReviews)
      .set({ decidedAt: now, status: "rejected", updatedAt: now })
      .where(
        and(
          eq(artistMappingReviews.artistId, input.artistId),
          eq(artistMappingReviews.provider, input.provider),
        ),
      );
    return { artistId: input.artistId, externalId: input.externalId, idempotent };
  });
}

export async function decideArtistMapping(
  db: RadarDatabase,
  input: {
    decision: "confirm" | "reject";
    provider: "apple_music" | "musicbrainz";
    reviewId: string;
  },
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
        eq(artistMappingReviews.provider, input.provider),
      ),
    });
    if (!review) throw new ArtistMappingReviewNotFoundError();
    const now = new Date();
    if (input.decision === "reject") {
      const idempotent = review.status === "rejected";
      await tx
        .update(artistMappingReviews)
        .set({ decidedAt: review.decidedAt ?? now, status: "rejected", updatedAt: now })
        .where(eq(artistMappingReviews.id, review.id));
      return { artistId: review.artistId, decision: "reject", externalId: null, idempotent };
    }
    if (!review.proposedExternalId) throw new ArtistMappingCandidateRequiredError();
    const current = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.artistId, review.artistId),
        eq(artistExternalIds.provider, input.provider),
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
        mappingSource: `user_confirmed_${input.provider}`,
        matchReasons: review.matchReasons,
        matchScore: review.matchScore,
        provider: input.provider,
        providerUrl: providerArtistUrl(input.provider, review.proposedExternalId),
      })
      .onConflictDoUpdate({
        target: [artistExternalIds.artistId, artistExternalIds.provider],
        set: {
          confirmed: true,
          confirmedAt,
          externalId: review.proposedExternalId,
          mappingSource: `user_confirmed_${input.provider}`,
          matchReasons: review.matchReasons,
          matchScore: review.matchScore,
          providerUrl: providerArtistUrl(input.provider, review.proposedExternalId),
          updatedAt: now,
        },
      });
    await tx
      .update(artistMappingReviews)
      .set({ decidedAt: now, status: "rejected", updatedAt: now })
      .where(
        and(
          eq(artistMappingReviews.artistId, review.artistId),
          eq(artistMappingReviews.provider, input.provider),
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

export interface ArtistMappingReviewPage {
  hasMore: boolean;
  nextCursor: string | null;
  reviews: Array<{
    artistId: string;
    artistName: string;
    confidence: string;
    createdAt: Date;
    id: string;
    name: string;
    proposedExternalId: string | null;
    provider: ProviderName;
    reasons: string[];
    status: string;
    updatedAt: Date;
  }>;
}

export async function listArtistMappingReviewsPage(
  db: RadarDatabase,
  options: {
    artistId?: string;
    cursor?: string;
    limit?: number;
    provider: "apple_music" | "musicbrainz";
  },
): Promise<ArtistMappingReviewPage> {
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
      provider: artistMappingReviews.provider,
      reasons: artistMappingReviews.matchReasons,
      status: artistMappingReviews.status,
      updatedAt: artistMappingReviews.updatedAt,
    })
    .from(artistMappingReviews)
    .innerJoin(artists, eq(artists.id, artistMappingReviews.artistId))
    .where(
      and(
        eq(artistMappingReviews.provider, options.provider),
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

export function providerArtistUrl(
  provider: "apple_music" | "musicbrainz",
  externalId: string,
): string {
  return provider === "apple_music"
    ? `https://music.apple.com/us/artist/${externalId}`
    : `https://musicbrainz.org/artist/${externalId}`;
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
    throw new Error("Mapping review cursor is malformed");
  }
  if (!isCursor(parsed) || !isUuid(parsed.id))
    throw new Error("Mapping review cursor is malformed");
  const updatedAt = new Date(parsed.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) throw new Error("Mapping review cursor is malformed");
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
