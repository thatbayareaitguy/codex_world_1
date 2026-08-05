import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachAppleMusicBatchScanRun,
  bootstrapAppleMusicIdentity,
  createAppleMusicBatch,
  finishAppleMusicBatch,
  finishAppleMusicArtist,
  loadAppleMusicBatchItems,
  startAppleMusicArtist,
} from "./apple-music-production";
import { createDatabase } from "./client";
import {
  confirmArtistMappingExternalId,
  decideArtistProviderIdentityStatus,
  decideArtistMapping,
  listArtistMappingReviewArtistsPage,
  listArtistMappingReviewsPage,
} from "./provider-mappings";
import {
  appleMusicArtistScans,
  appleMusicScanBatches,
  artistExternalIds,
  artistFollows,
  artistMappingReviews,
  artistProviderIdentityStatuses,
  artists,
  scanRuns,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Apple Music production identity and batches", () => {
  const connection = createDatabase(databaseUrl);
  const artistIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const userId = randomUUID();

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.db
      .insert(users)
      .values({ displayName: "Apple Test User", email: "apple-test@example.test", id: userId });
    await connection.db.insert(artists).values(
      artistIds.map((id, index) => ({
        id,
        name: `Apple Artist ${index + 1}`,
        normalizedName: `apple artist ${index + 1}`,
      })),
    );
    await connection.db
      .insert(artistFollows)
      .values(artistIds.map((artistId) => ({ artistId, source: "test", userId })));
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("bootstraps strong mappings and unresolved reviews idempotently", async () => {
    const entries = [
      seed(artistIds[0]!, "high_confidence_seed", "101"),
      seed(artistIds[1]!, "evidence_supported_seed", "102"),
      { ...seed(artistIds[2]!, "ambiguous_seed"), alternateCandidateIds: ["201", "202"] },
      {
        ...seed(artistIds[3]!, "manual_review_required"),
        manualReviewReason: "No safe candidate",
      },
    ];

    expect(await bootstrapAppleMusicIdentity(connection.db, entries)).toEqual({
      candidateFree: 1,
      mappings: 2,
      reviewArtists: 2,
      reviews: 3,
    });
    expect(await bootstrapAppleMusicIdentity(connection.db, entries)).toEqual({
      candidateFree: 0,
      mappings: 0,
      reviewArtists: 2,
      reviews: 0,
    });
    expect(
      await connection.db
        .select()
        .from(artistExternalIds)
        .where(eq(artistExternalIds.provider, "apple_music")),
    ).toHaveLength(2);
    const page = await listArtistMappingReviewsPage(connection.db, {
      limit: 20,
      provider: "apple_music",
    });
    expect(page.reviews).toHaveLength(3);
    expect(page.reviews.filter((review) => review.proposedExternalId === null)).toHaveLength(1);
    const artistPage = await listArtistMappingReviewArtistsPage(connection.db, {
      limit: 20,
      provider: "apple_music",
    });
    expect(artistPage.summary).toEqual({ pendingCandidates: 3, unresolvedArtists: 2 });
    expect(new Set(artistPage.reviews.map((review) => review.artistId)).size).toBe(2);
    expect(
      await connection.db
        .select()
        .from(artistProviderIdentityStatuses)
        .where(eq(artistProviderIdentityStatuses.provider, "apple_music")),
    ).toHaveLength(4);
  });

  it("confirms, replaces, and manually supplies mappings while resolving sibling reviews", async () => {
    const ambiguous = await connection.db.query.artistMappingReviews.findFirst({
      where: and(
        eq(artistMappingReviews.artistId, artistIds[2]!),
        eq(artistMappingReviews.proposedExternalId, "201"),
      ),
    });
    expect(ambiguous).toBeDefined();
    const first = await decideArtistMapping(connection.db, {
      decision: "confirm",
      provider: "apple_music",
      reviewId: ambiguous!.id,
    });
    expect(first).toMatchObject({ externalId: "201", idempotent: false });
    expect(
      await decideArtistMapping(connection.db, {
        decision: "confirm",
        provider: "apple_music",
        reviewId: ambiguous!.id,
      }),
    ).toMatchObject({ externalId: "201", idempotent: true });
    expect(
      await connection.db
        .select()
        .from(artistMappingReviews)
        .where(
          and(
            eq(artistMappingReviews.artistId, artistIds[2]!),
            eq(artistMappingReviews.status, "pending"),
          ),
        ),
    ).toHaveLength(0);

    expect(
      await decideArtistProviderIdentityStatus(connection.db, {
        artistId: artistIds[3]!,
        provider: "apple_music",
        status: "confirmed_unavailable",
      }),
    ).toMatchObject({ idempotent: false, status: "confirmed_unavailable" });
    expect(
      await decideArtistProviderIdentityStatus(connection.db, {
        artistId: artistIds[3]!,
        provider: "apple_music",
        status: "confirmed_unavailable",
      }),
    ).toMatchObject({ idempotent: true, status: "confirmed_unavailable" });
    expect(
      await confirmArtistMappingExternalId(connection.db, {
        artistId: artistIds[3]!,
        externalId: "301",
        provider: "apple_music",
      }),
    ).toMatchObject({ externalId: "301", idempotent: false });
    expect(
      await confirmArtistMappingExternalId(connection.db, {
        artistId: artistIds[3]!,
        externalId: "301",
        provider: "apple_music",
      }),
    ).toMatchObject({ externalId: "301", idempotent: true });
    expect(
      await connection.db.query.artistProviderIdentityStatuses.findFirst({
        where: and(
          eq(artistProviderIdentityStatuses.artistId, artistIds[3]!),
          eq(artistProviderIdentityStatuses.provider, "apple_music"),
        ),
      }),
    ).toMatchObject({ externalId: "301", status: "manually_confirmed" });
  });

  it("resumes only a compatible persisted batch and advances per artist", async () => {
    const firstMappings = [
      { appleArtistId: "101", artistId: artistIds[0]! },
      { appleArtistId: "102", artistId: artistIds[1]! },
    ];
    const batchId = await createAppleMusicBatch(connection.db, firstMappings);
    expect(await createAppleMusicBatch(connection.db, firstMappings)).toBe(batchId);
    const differentBatch = await createAppleMusicBatch(connection.db, [firstMappings[0]!]);
    expect(differentBatch).not.toBe(batchId);

    const [item] = await loadAppleMusicBatchItems(connection.db, batchId);
    expect(item).toBeDefined();
    expect(await startAppleMusicArtist(connection.db, item!.id)).toBe(true);
    await finishAppleMusicArtist(connection.db, {
      candidateCount: 2,
      id: item!.id,
      releaseCount: 1,
      requestCount: 3,
      status: "completed",
    });
    expect(
      await connection.db.query.appleMusicArtistScans.findFirst({
        where: eq(appleMusicArtistScans.id, item!.id),
      }),
    ).toMatchObject({ candidateCount: 2, requestCount: 3, status: "completed" });
  });

  it("records a terminal-only partial batch as finished", async () => {
    const batchId = await createAppleMusicBatch(connection.db, [
      { appleArtistId: "101", artistId: artistIds[0]! },
      { appleArtistId: "102", artistId: artistIds[1]! },
      { appleArtistId: "201", artistId: artistIds[2]! },
    ]);
    const items = await loadAppleMusicBatchItems(connection.db, batchId);
    for (const [index, item] of items.entries()) {
      expect(await startAppleMusicArtist(connection.db, item.id)).toBe(true);
      await finishAppleMusicArtist(connection.db, {
        candidateCount: 0,
        ...(index === 0 ? { errorClassification: "not_found" } : {}),
        id: item.id,
        releaseCount: 0,
        requestCount: 2,
        status: index === 0 ? "terminal" : "completed",
      });
    }

    await finishAppleMusicBatch(connection.db, batchId, "partial");

    const batch = await connection.db.query.appleMusicScanBatches.findFirst({
      where: eq(appleMusicScanBatches.id, batchId),
    });
    expect(batch).toMatchObject({ failedArtists: 1, status: "partial" });
    expect(batch?.finishedAt).toBeInstanceOf(Date);
  });

  it("preserves the original batch start while attaching a resumed scan run", async () => {
    const batchId = await createAppleMusicBatch(connection.db, [
      { appleArtistId: "101", artistId: artistIds[0]! },
      { appleArtistId: "102", artistId: artistIds[1]! },
      { appleArtistId: "201", artistId: artistIds[2]! },
      { appleArtistId: "301", artistId: artistIds[3]! },
    ]);
    const firstRunId = randomUUID();
    const resumedRunId = randomUUID();
    await connection.db.insert(scanRuns).values([
      { id: firstRunId, provider: "apple_music", providersRequested: ["apple_music"] },
      { id: resumedRunId, provider: "apple_music", providersRequested: ["apple_music"] },
    ]);
    const firstStartedAt = new Date("2026-08-04T10:00:00.000Z");

    await attachAppleMusicBatchScanRun(connection.db, batchId, firstRunId, firstStartedAt);
    await attachAppleMusicBatchScanRun(
      connection.db,
      batchId,
      resumedRunId,
      new Date("2026-08-04T11:00:00.000Z"),
    );

    const batch = await connection.db.query.appleMusicScanBatches.findFirst({
      where: eq(appleMusicScanBatches.id, batchId),
    });
    expect(batch).toMatchObject({ scanRunId: resumedRunId, startedAt: firstStartedAt });
  });
});

function seed(
  watchedArtistId: string,
  classification:
    | "ambiguous_seed"
    | "evidence_supported_seed"
    | "high_confidence_seed"
    | "manual_review_required",
  candidateArtistId?: string,
) {
  return {
    ...(candidateArtistId ? { candidateArtistId } : {}),
    alternateCandidateIds: [] as string[],
    canonicalArtistName: "Synthetic Apple Artist",
    classification,
    evidenceSources: ["synthetic_verified_artifact"],
    watchedArtistId,
  };
}
