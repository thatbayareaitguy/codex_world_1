import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  releaseExternalIds,
  releases,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  spotifyReleaseTrackItems,
  spotifyReleaseTrackPages,
  spotifyReleaseTrackRetrievals,
  trackExternalIds,
} from "./schema";

export type SpotifyReleaseTrackProgressStatus =
  "not_started" | "in_progress" | "partial" | "completed" | "paused" | "rate_limited" | "failed";

export interface SpotifyReleaseTrackResume {
  nextOffset: number;
  status: "partial" | "paused" | "rate_limited" | "failed";
}

export interface SpotifyReleaseTrackItemInput {
  discNumber: number;
  providerTrackId: string;
  trackNumber: number;
}

export interface SpotifyReleaseReconciliationTarget {
  expectedTotalTracks: number;
  fetchedTrackCount: number;
  nextOffset: number | null;
  reconciliationCycleId: string | null;
  releaseId: string;
  releaseType: string;
  spotifyAlbumId: string;
  startedAt: Date | null;
  status: SpotifyReleaseTrackProgressStatus;
  title: string;
}

export async function loadSpotifyReleaseTrackResume(
  db: RadarDatabase,
): Promise<ReadonlyMap<string, SpotifyReleaseTrackResume>> {
  const rows = await db
    .select({
      nextOffset: spotifyReleaseTrackRetrievals.nextOffset,
      spotifyAlbumId: spotifyReleaseTrackRetrievals.spotifyAlbumId,
      status: spotifyReleaseTrackRetrievals.status,
    })
    .from(spotifyReleaseTrackRetrievals)
    .where(
      inArray(spotifyReleaseTrackRetrievals.status, [
        "partial",
        "paused",
        "rate_limited",
        "failed",
      ]),
    );
  return new Map(
    rows.map((row) => [
      row.spotifyAlbumId,
      {
        nextOffset: row.nextOffset ?? 0,
        status: row.status as SpotifyReleaseTrackResume["status"],
      },
    ]),
  );
}

export async function startSpotifyReleaseTrackRetrieval(
  db: RadarDatabase,
  input: {
    expectedTotalTracks: number;
    reconciliationCycleId?: string | null;
    spotifyAlbumId: string;
  },
): Promise<void> {
  const release = await db.query.releaseExternalIds.findFirst({
    where: and(
      eq(releaseExternalIds.provider, "spotify"),
      eq(releaseExternalIds.externalId, input.spotifyAlbumId),
    ),
    columns: { releaseId: true },
  });
  const existing = await db.query.spotifyReleaseTrackRetrievals.findFirst({
    where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, input.spotifyAlbumId),
    columns: { reconciliationCycleId: true },
  });
  const startsNewCycle = Boolean(
    existing &&
    input.reconciliationCycleId &&
    existing.reconciliationCycleId !== input.reconciliationCycleId,
  );
  const now = new Date();
  await db
    .insert(spotifyReleaseTrackRetrievals)
    .values({
      expectedTotalTracks: input.expectedTotalTracks,
      ...(release ? { releaseId: release.releaseId } : {}),
      ...(input.reconciliationCycleId
        ? { reconciliationCycleId: input.reconciliationCycleId }
        : {}),
      spotifyAlbumId: input.spotifyAlbumId,
      startedAt: now,
      status: "in_progress",
    })
    .onConflictDoUpdate({
      target: spotifyReleaseTrackRetrievals.spotifyAlbumId,
      set: {
        expectedTotalTracks: input.expectedTotalTracks,
        ...(release ? { releaseId: release.releaseId } : {}),
        ...(input.reconciliationCycleId
          ? { reconciliationCycleId: input.reconciliationCycleId }
          : {}),
        lastErrorClassification: null,
        retryEligibleAt: null,
        ...(startsNewCycle
          ? {
              completedAt: null,
              discrepancy: null,
              fetchedTrackCount: 0,
              lastPageCompletedAt: null,
              nextOffset: 0,
              pagesCompleted: 0,
              startedAt: now,
            }
          : {}),
        status: "in_progress",
        updatedAt: now,
      },
    });
}

export async function recordSpotifyReleaseTrackPage(
  db: RadarDatabase,
  input: {
    errorClassification?: string;
    expectedTotalTracks: number;
    finishedAt: Date;
    items: SpotifyReleaseTrackItemInput[];
    nextOffset: number | null;
    offset: number;
    reconciliationCycleId?: string | null;
    spotifyAlbumId: string;
    startedAt: Date;
    terminal: boolean;
  },
): Promise<{ fetchedTrackCount: number; status: SpotifyReleaseTrackProgressStatus }> {
  return db.transaction(async (tx) => {
    const release = await tx.query.releaseExternalIds.findFirst({
      where: and(
        eq(releaseExternalIds.provider, "spotify"),
        eq(releaseExternalIds.externalId, input.spotifyAlbumId),
      ),
      columns: { releaseId: true },
    });
    const [retrieval] = await tx
      .insert(spotifyReleaseTrackRetrievals)
      .values({
        expectedTotalTracks: input.expectedTotalTracks,
        ...(release ? { releaseId: release.releaseId } : {}),
        ...(input.reconciliationCycleId
          ? { reconciliationCycleId: input.reconciliationCycleId }
          : {}),
        spotifyAlbumId: input.spotifyAlbumId,
        startedAt: input.startedAt,
        status: "in_progress",
      })
      .onConflictDoUpdate({
        target: spotifyReleaseTrackRetrievals.spotifyAlbumId,
        set: {
          expectedTotalTracks: input.expectedTotalTracks,
          ...(release ? { releaseId: release.releaseId } : {}),
          ...(input.reconciliationCycleId
            ? { reconciliationCycleId: input.reconciliationCycleId }
            : {}),
          status: "in_progress",
          updatedAt: input.finishedAt,
        },
      })
      .returning({
        id: spotifyReleaseTrackRetrievals.id,
        startedAt: spotifyReleaseTrackRetrievals.startedAt,
      });
    if (!retrieval) throw new Error("Spotify release track retrieval could not be recorded.");
    const cycleStartedAt = retrieval.startedAt ?? input.startedAt;

    const uniqueItems = [
      ...new Map(input.items.map((item) => [item.providerTrackId, item])).values(),
    ];
    if (uniqueItems.length > 0) {
      await tx
        .insert(spotifyReleaseTrackItems)
        .values(
          uniqueItems.map((item) => ({
            discNumber: item.discNumber,
            pageOffset: input.offset,
            providerTrackId: item.providerTrackId,
            retrievalId: retrieval.id,
            trackNumber: item.trackNumber,
          })),
        )
        .onConflictDoUpdate({
          target: [spotifyReleaseTrackItems.retrievalId, spotifyReleaseTrackItems.providerTrackId],
          set: {
            discNumber: sql`excluded.disc_number`,
            lastObservedAt: input.finishedAt,
            pageOffset: input.offset,
            trackNumber: sql`excluded.track_number`,
          },
        });
    }
    await tx
      .insert(spotifyReleaseTrackPages)
      .values({
        finishedAt: input.finishedAt,
        itemCount: input.items.length,
        nextOffset: input.nextOffset,
        offset: input.offset,
        retrievalId: retrieval.id,
        startedAt: input.startedAt,
        uniqueItemCount: uniqueItems.length,
      })
      .onConflictDoUpdate({
        target: [spotifyReleaseTrackPages.retrievalId, spotifyReleaseTrackPages.offset],
        set: {
          finishedAt: input.finishedAt,
          itemCount: input.items.length,
          nextOffset: input.nextOffset,
          startedAt: input.startedAt,
          uniqueItemCount: uniqueItems.length,
        },
      });

    const [itemCount] = await tx
      .select({ value: count() })
      .from(spotifyReleaseTrackItems)
      .where(
        and(
          eq(spotifyReleaseTrackItems.retrievalId, retrieval.id),
          gte(spotifyReleaseTrackItems.lastObservedAt, cycleStartedAt),
        ),
      );
    const [pageCount] = await tx
      .select({ value: count() })
      .from(spotifyReleaseTrackPages)
      .where(
        and(
          eq(spotifyReleaseTrackPages.retrievalId, retrieval.id),
          gte(spotifyReleaseTrackPages.finishedAt, cycleStartedAt),
        ),
      );
    const fetchedTrackCount = itemCount?.value ?? 0;
    const countMatches = fetchedTrackCount === input.expectedTotalTracks;
    const status: SpotifyReleaseTrackProgressStatus =
      input.terminal && countMatches && !input.errorClassification ? "completed" : "partial";
    const discrepancy = input.errorClassification
      ? input.errorClassification
      : input.terminal && !countMatches
        ? fetchedTrackCount < input.expectedTotalTracks
          ? `missing_${input.expectedTotalTracks - fetchedTrackCount}_tracks`
          : `excess_${fetchedTrackCount - input.expectedTotalTracks}_tracks`
        : null;
    await tx
      .update(spotifyReleaseTrackRetrievals)
      .set({
        completedAt: status === "completed" ? input.finishedAt : null,
        discrepancy,
        expectedTotalTracks: input.expectedTotalTracks,
        fetchedTrackCount,
        lastErrorClassification: input.errorClassification ?? null,
        lastPageCompletedAt: input.finishedAt,
        nextOffset:
          status === "completed"
            ? null
            : input.errorClassification || (input.terminal && !countMatches)
              ? 0
              : input.nextOffset,
        pagesCompleted: pageCount?.value ?? 0,
        status,
        updatedAt: input.finishedAt,
      })
      .where(eq(spotifyReleaseTrackRetrievals.id, retrieval.id));
    return { fetchedTrackCount, status };
  });
}

export async function markSpotifyReleaseTrackInterrupted(
  db: RadarDatabase,
  input: {
    errorClassification: string;
    retryEligibleAt?: Date;
    spotifyAlbumId: string;
    status: "failed" | "paused" | "rate_limited";
  },
): Promise<void> {
  await db
    .update(spotifyReleaseTrackRetrievals)
    .set({
      lastErrorClassification: input.errorClassification.slice(0, 100),
      retryEligibleAt: input.retryEligibleAt ?? null,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, input.spotifyAlbumId));
}

export async function loadSpotifyReleaseReconciliationTargets(
  db: RadarDatabase,
  releaseIds: readonly string[],
): Promise<SpotifyReleaseReconciliationTarget[]> {
  if (releaseIds.length === 0) return [];
  return db
    .select({
      expectedTotalTracks: spotifyReleaseTrackRetrievals.expectedTotalTracks,
      fetchedTrackCount: spotifyReleaseTrackRetrievals.fetchedTrackCount,
      nextOffset: spotifyReleaseTrackRetrievals.nextOffset,
      reconciliationCycleId: spotifyReleaseTrackRetrievals.reconciliationCycleId,
      releaseId: releases.id,
      releaseType: releases.releaseType,
      spotifyAlbumId: spotifyReleaseTrackRetrievals.spotifyAlbumId,
      startedAt: spotifyReleaseTrackRetrievals.startedAt,
      status: spotifyReleaseTrackRetrievals.status,
      title: releases.title,
    })
    .from(spotifyReleaseTrackRetrievals)
    .innerJoin(releases, eq(releases.id, spotifyReleaseTrackRetrievals.releaseId))
    .innerJoin(
      releaseExternalIds,
      and(
        eq(releaseExternalIds.releaseId, releases.id),
        eq(releaseExternalIds.provider, "spotify"),
        eq(releaseExternalIds.externalId, spotifyReleaseTrackRetrievals.spotifyAlbumId),
      ),
    )
    .where(inArray(releases.id, [...releaseIds]));
}

export async function validateSpotifyReleaseTrackMappings(
  db: RadarDatabase,
  input: {
    providerTrackIds: readonly string[];
    releaseId: string;
    spotifyAlbumId: string;
  },
): Promise<{
  missingAppearanceTrackIds: string[];
  missingCanonicalTrackIds: string[];
}> {
  const providerTrackIds = [...new Set(input.providerTrackIds)];
  if (providerTrackIds.length === 0) {
    return { missingAppearanceTrackIds: [], missingCanonicalTrackIds: [] };
  }
  const [canonicalRows, appearanceRows] = await Promise.all([
    db
      .select({ providerTrackId: trackExternalIds.externalId })
      .from(trackExternalIds)
      .where(
        and(
          eq(trackExternalIds.provider, "spotify"),
          inArray(trackExternalIds.externalId, providerTrackIds),
        ),
      ),
    db
      .select({ providerTrackId: releaseTrackAppearanceSources.providerTrackId })
      .from(releaseTrackAppearanceSources)
      .innerJoin(
        releaseTrackAppearances,
        eq(releaseTrackAppearances.id, releaseTrackAppearanceSources.appearanceId),
      )
      .where(
        and(
          eq(releaseTrackAppearanceSources.provider, "spotify"),
          eq(releaseTrackAppearanceSources.providerReleaseId, input.spotifyAlbumId),
          eq(releaseTrackAppearances.releaseId, input.releaseId),
          inArray(releaseTrackAppearanceSources.providerTrackId, providerTrackIds),
        ),
      ),
  ]);
  const canonical = new Set(canonicalRows.map((row) => row.providerTrackId));
  const appearances = new Set(appearanceRows.map((row) => row.providerTrackId));
  return {
    missingAppearanceTrackIds: providerTrackIds.filter((id) => !appearances.has(id)),
    missingCanonicalTrackIds: providerTrackIds.filter((id) => !canonical.has(id)),
  };
}

export function createSpotifyReleaseReconciliationRepository(db: RadarDatabase) {
  return {
    listTargets: (releaseIds: readonly string[]) =>
      loadSpotifyReleaseReconciliationTargets(db, releaseIds),
    markInterrupted: (input: Parameters<typeof markSpotifyReleaseTrackInterrupted>[1]) =>
      markSpotifyReleaseTrackInterrupted(db, input),
    recordPage: (input: Parameters<typeof recordSpotifyReleaseTrackPage>[1]) =>
      recordSpotifyReleaseTrackPage(db, input),
    start: (input: Parameters<typeof startSpotifyReleaseTrackRetrieval>[1]) =>
      startSpotifyReleaseTrackRetrieval(db, input),
    validateMappings: (input: Parameters<typeof validateSpotifyReleaseTrackMappings>[1]) =>
      validateSpotifyReleaseTrackMappings(db, input),
  };
}

export async function spotifyReleaseTrackCompletenessSummary(db: RadarDatabase) {
  const rows = await db
    .select({ status: spotifyReleaseTrackRetrievals.status, value: count() })
    .from(spotifyReleaseTrackRetrievals)
    .groupBy(spotifyReleaseTrackRetrievals.status);
  const countFor = (status: SpotifyReleaseTrackProgressStatus) =>
    rows.find((row) => row.status === status)?.value ?? 0;
  const [missing] = await db
    .select({
      value: sql<number>`coalesce(sum(greatest(${spotifyReleaseTrackRetrievals.expectedTotalTracks} - ${spotifyReleaseTrackRetrievals.fetchedTrackCount}, 0)), 0)::int`,
    })
    .from(spotifyReleaseTrackRetrievals)
    .where(
      inArray(spotifyReleaseTrackRetrievals.status, [
        "not_started",
        "in_progress",
        "partial",
        "paused",
        "rate_limited",
        "failed",
      ]),
    );
  const [discrepancies] = await db
    .select({ value: count() })
    .from(spotifyReleaseTrackRetrievals)
    .where(sql`${spotifyReleaseTrackRetrievals.discrepancy} is not null`);
  return {
    awaitingResume:
      countFor("partial") + countFor("paused") + countFor("rate_limited") + countFor("failed"),
    completed: countFor("completed"),
    discrepancies: discrepancies?.value ?? 0,
    failed: countFor("failed"),
    inProgress: countFor("in_progress"),
    missingTracks: missing?.value ?? 0,
    notStarted: countFor("not_started"),
    paused: countFor("paused"),
    partial: countFor("partial"),
    rateLimited: countFor("rate_limited"),
  };
}
