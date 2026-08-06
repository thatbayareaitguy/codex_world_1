import { and, asc, count, countDistinct, desc, eq, gt, inArray, lt, ne, or } from "drizzle-orm";
import type { ProviderName } from "@radar/core";
import type { RadarDatabase } from "./client";
import {
  artistExternalIds,
  artistMappingReviews,
  artistProviderIdentityStatuses,
  artists,
} from "./schema";

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
    if (input.provider === "apple_music") {
      await tx
        .insert(artistProviderIdentityStatuses)
        .values({
          artistId: input.artistId,
          decidedAt: now,
          decidedBy: "user",
          evidence: ["User supplied the exact Apple Music artist ID"],
          externalId: input.externalId,
          externalIds: [input.externalId],
          provider: input.provider,
          reason: "User manually confirmed the provider identity.",
          status: "manually_confirmed",
        })
        .onConflictDoUpdate({
          target: [
            artistProviderIdentityStatuses.artistId,
            artistProviderIdentityStatuses.provider,
          ],
          set: {
            decidedAt: now,
            decidedBy: "user",
            evidence: ["User supplied the exact Apple Music artist ID"],
            externalId: input.externalId,
            externalIds: [input.externalId],
            linkedArtistId: null,
            reason: "User manually confirmed the provider identity.",
            status: "manually_confirmed",
            updatedAt: now,
          },
        });
    }
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
    if (input.provider === "apple_music") {
      await tx
        .insert(artistProviderIdentityStatuses)
        .values({
          artistId: review.artistId,
          decidedAt: now,
          decidedBy: "user",
          evidence: review.matchReasons,
          externalId: review.proposedExternalId,
          externalIds: [review.proposedExternalId],
          provider: input.provider,
          reason: "User confirmed a reviewed Apple Music candidate.",
          status: "manually_confirmed",
        })
        .onConflictDoUpdate({
          target: [
            artistProviderIdentityStatuses.artistId,
            artistProviderIdentityStatuses.provider,
          ],
          set: {
            decidedAt: now,
            decidedBy: "user",
            evidence: review.matchReasons,
            externalId: review.proposedExternalId,
            externalIds: [review.proposedExternalId],
            linkedArtistId: null,
            reason: "User confirmed a reviewed Apple Music candidate.",
            status: "manually_confirmed",
            updatedAt: now,
          },
        });
    }
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
    confirmedEvidence?: Array<{
      externalId: string;
      mappingSource: string;
      provider: ProviderName;
      url: string | null;
    }>;
  }>;
}

export interface ArtistMappingReviewArtistPage extends ArtistMappingReviewPage {
  summary: {
    pendingCandidates: number;
    unresolvedArtists: number;
  };
}

export async function listArtistMappingReviewArtistsPage(
  db: RadarDatabase,
  options: {
    cursor?: string;
    limit?: number;
    provider: "apple_music" | "musicbrainz";
  },
): Promise<ArtistMappingReviewArtistPage> {
  const limit = Math.max(5, Math.min(Math.trunc(options.limit ?? 20), 50));
  const cursor = options.cursor ? decodeArtistCursor(options.cursor) : null;
  const pending = and(
    eq(artistMappingReviews.provider, options.provider),
    eq(artistMappingReviews.status, "pending"),
    ...(cursor
      ? [
          or(
            gt(artists.name, cursor.artistName),
            and(eq(artists.name, cursor.artistName), gt(artists.id, cursor.artistId)),
          )!,
        ]
      : []),
  );
  const artistRows = await db
    .select({ artistId: artists.id, artistName: artists.name })
    .from(artistMappingReviews)
    .innerJoin(artists, eq(artists.id, artistMappingReviews.artistId))
    .where(pending)
    .groupBy(artists.id, artists.name)
    .orderBy(asc(artists.name), asc(artists.id))
    .limit(limit + 1);
  const hasMore = artistRows.length > limit;
  const selectedArtists = artistRows.slice(0, limit);
  const artistIds = selectedArtists.map((artist) => artist.artistId);
  const rows = artistIds.length
    ? await db
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
            eq(artistMappingReviews.status, "pending"),
            inArray(artistMappingReviews.artistId, artistIds),
          ),
        )
        .orderBy(
          asc(artists.name),
          desc(artistMappingReviews.matchScore),
          asc(artistMappingReviews.id),
        )
    : [];
  const evidenceRows = artistIds.length
    ? await db
        .select({
          artistId: artistExternalIds.artistId,
          externalId: artistExternalIds.externalId,
          mappingSource: artistExternalIds.mappingSource,
          provider: artistExternalIds.provider,
          url: artistExternalIds.providerUrl,
        })
        .from(artistExternalIds)
        .where(
          and(
            inArray(artistExternalIds.artistId, artistIds),
            eq(artistExternalIds.confirmed, true),
          ),
        )
        .orderBy(asc(artistExternalIds.provider))
    : [];
  const evidenceByArtist = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const current = evidenceByArtist.get(row.artistId) ?? [];
    current.push(row);
    evidenceByArtist.set(row.artistId, current);
  }
  const [summary] = await db
    .select({
      pendingCandidates: count(artistMappingReviews.id),
      unresolvedArtists: countDistinct(artistMappingReviews.artistId),
    })
    .from(artistMappingReviews)
    .where(
      and(
        eq(artistMappingReviews.provider, options.provider),
        eq(artistMappingReviews.status, "pending"),
      ),
    );
  const last = selectedArtists.at(-1);
  return {
    hasMore,
    nextCursor: hasMore && last ? encodeArtistCursor(last.artistName, last.artistId) : null,
    reviews: rows.map((row) => ({
      ...row,
      confirmedEvidence: (evidenceByArtist.get(row.artistId) ?? []).map(
        ({ externalId, mappingSource, provider, url }) => ({
          externalId,
          mappingSource,
          provider,
          url,
        }),
      ),
    })),
    summary: {
      pendingCandidates: Number(summary?.pendingCandidates ?? 0),
      unresolvedArtists: Number(summary?.unresolvedArtists ?? 0),
    },
  };
}

export async function decideArtistProviderIdentityStatus(
  db: RadarDatabase,
  input: {
    artistId: string;
    linkedArtistId?: string;
    provider: "apple_music" | "spotify";
    status: "alias_or_duplicate" | "confirmed_unavailable" | "intentionally_excluded";
  },
): Promise<{ artistId: string; idempotent: boolean; status: typeof input.status }> {
  if (input.status === "alias_or_duplicate" && !input.linkedArtistId) {
    throw new Error("Alias or duplicate decisions require a canonical artist.");
  }
  if (input.linkedArtistId === input.artistId) {
    throw new Error("An artist cannot be linked to itself.");
  }
  return db.transaction(async (tx) => {
    const current = await tx.query.artistProviderIdentityStatuses.findFirst({
      where: and(
        eq(artistProviderIdentityStatuses.artistId, input.artistId),
        eq(artistProviderIdentityStatuses.provider, input.provider),
      ),
    });
    const idempotent =
      current?.status === input.status &&
      (current.linkedArtistId ?? null) === (input.linkedArtistId ?? null);
    const now = new Date();
    const reason = identityDecisionReason(input.status);
    await tx
      .insert(artistProviderIdentityStatuses)
      .values({
        artistId: input.artistId,
        decidedAt: current?.decidedAt ?? now,
        decidedBy: "user",
        evidence: [reason],
        externalIds: [],
        linkedArtistId: input.linkedArtistId,
        provider: input.provider,
        reason,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [artistProviderIdentityStatuses.artistId, artistProviderIdentityStatuses.provider],
        set: {
          decidedAt: current?.decidedAt ?? now,
          decidedBy: "user",
          evidence: [reason],
          externalId: null,
          externalIds: [],
          linkedArtistId: input.linkedArtistId ?? null,
          reason,
          status: input.status,
          updatedAt: now,
          userNote: null,
        },
      });
    await tx
      .update(artistMappingReviews)
      .set({ decidedAt: now, status: "rejected", updatedAt: now })
      .where(
        and(
          eq(artistMappingReviews.artistId, input.artistId),
          eq(artistMappingReviews.provider, input.provider),
          eq(artistMappingReviews.status, "pending"),
        ),
      );
    return { artistId: input.artistId, idempotent, status: input.status };
  });
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

function encodeArtistCursor(artistName: string, artistId: string): string {
  return Buffer.from(JSON.stringify({ artistId, artistName })).toString("base64url");
}

function decodeArtistCursor(value: string): { artistId: string; artistName: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Artist mapping cursor is malformed");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("artistId" in parsed) ||
    typeof parsed.artistId !== "string" ||
    !isUuid(parsed.artistId) ||
    !("artistName" in parsed) ||
    typeof parsed.artistName !== "string"
  ) {
    throw new Error("Artist mapping cursor is malformed");
  }
  return { artistId: parsed.artistId, artistName: parsed.artistName };
}

function identityDecisionReason(
  status: "alias_or_duplicate" | "confirmed_unavailable" | "intentionally_excluded",
): string {
  if (status === "confirmed_unavailable") {
    return "User confirmed that no provider identity is available.";
  }
  if (status === "alias_or_duplicate") {
    return "User linked this provider identity state to another canonical artist.";
  }
  return "User intentionally excluded this artist from the provider.";
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
