import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  spotifyArtistCoverage,
  spotifyArtistScans,
  spotifyCatalogReleases,
  spotifyPageScans,
  spotifyScanBatches,
} from "./schema";

export type SpotifyCoverageStatus =
  | "daily_current"
  | "reconciliation_queued"
  | "reconciliation_in_progress"
  | "fully_reconciled"
  | "rate_limited"
  | "failed"
  | "paused";

export interface SpotifyCatalogReleaseSummary {
  externalReleaseId: string;
  releaseDate: string;
  releaseDatePrecision: string;
  releaseType: string;
  title: string;
  totalTracks: number;
}

export interface SpotifyCoverageWork {
  artistId: string;
  cycleId: string | null;
  startOffset: number;
}

export async function prepareSpotifyCoverage(
  db: RadarDatabase,
  input: {
    artistIds: string[];
    cycleDays: number;
    mode: "initial" | "daily" | "reconciliation";
    newCycle: boolean;
    now?: Date;
  },
): Promise<SpotifyCoverageWork[]> {
  const now = input.now ?? new Date();
  if (input.artistIds.length === 0) return [];
  await db
    .insert(spotifyArtistCoverage)
    .values(input.artistIds.map((artistId) => ({ artistId })))
    .onConflictDoNothing();
  const rows = await db
    .select()
    .from(spotifyArtistCoverage)
    .where(inArray(spotifyArtistCoverage.artistId, input.artistIds));

  const result: SpotifyCoverageWork[] = [];
  for (const artistId of input.artistIds) {
    const row = rows.find((candidate) => candidate.artistId === artistId);
    if (!row) throw new Error("Spotify artist coverage could not be initialized.");
    if (input.mode === "daily") {
      result.push({ artistId, cycleId: row.reconciliationCycleId, startOffset: 0 });
      continue;
    }
    const cycleExpired =
      row.lastFullReconciliationAt !== null &&
      now.getTime() - row.lastFullReconciliationAt.getTime() >= input.cycleDays * 86_400_000;
    const beginNewCycle =
      input.newCycle || !row.reconciliationCycleId || (!row.partial && cycleExpired);
    const cycleId = beginNewCycle ? randomUUID() : row.reconciliationCycleId;
    const startOffset = beginNewCycle ? 0 : row.nextOffset;
    await db
      .update(spotifyArtistCoverage)
      .set({
        ...(beginNewCycle
          ? {
              catalogPagesCompleted: 0,
              estimatedTotalPages: null,
              nextOffset: 0,
              pagesScannedInCycle: 0,
              reconciliationCompletedAt: null,
              reconciliationCycleId: cycleId,
              reconciliationStartedAt: now,
            }
          : row.reconciliationStartedAt
            ? {}
            : { reconciliationStartedAt: now }),
        lastReconciliationError: null,
        partial: true,
        status: "reconciliation_in_progress",
        updatedAt: now,
      })
      .where(eq(spotifyArtistCoverage.artistId, artistId));
    result.push({ artistId, cycleId, startOffset });
  }
  return result;
}

export async function recordSpotifyPage(
  db: RadarDatabase,
  input: {
    albumDetailRequests: number;
    artistId: string;
    artistScanId: string;
    backfillReleaseCount: number;
    batchId: string;
    candidateCount: number;
    cycleId: string | null;
    dryRun: boolean;
    durationMs: number;
    finishedAt: Date;
    itemCount: number;
    mode: "initial" | "daily" | "reconciliation";
    nextOffset: number | null;
    offset: number;
    pageNumber: number;
    releases: SpotifyCatalogReleaseSummary[];
    requestCount: number;
    startedAt: Date;
    totalItems: number;
  },
): Promise<void> {
  const anotherPage = input.nextOffset !== null;
  await db.transaction(async (tx) => {
    const existingPage = await tx.query.spotifyPageScans.findFirst({
      where: and(
        eq(spotifyPageScans.artistScanId, input.artistScanId),
        eq(spotifyPageScans.spotifyOffset, input.offset),
      ),
      columns: { id: true },
    });
    await tx
      .insert(spotifyPageScans)
      .values({
        albumDetailRequests: input.albumDetailRequests,
        anotherPage,
        artistId: input.artistId,
        artistScanId: input.artistScanId,
        backfillReleaseCount: input.backfillReleaseCount,
        batchId: input.batchId,
        candidateCount: input.candidateCount,
        dryRun: input.dryRun,
        durationMs: input.durationMs,
        finishedAt: input.finishedAt,
        itemCount: input.itemCount,
        mode: input.mode,
        nextOffset: input.nextOffset,
        pageNumber: input.pageNumber,
        reconciliationCycleId: input.cycleId,
        requestCount: input.requestCount,
        spotifyOffset: input.offset,
        startedAt: input.startedAt,
        totalItems: input.totalItems,
      })
      .onConflictDoUpdate({
        target: [spotifyPageScans.artistScanId, spotifyPageScans.spotifyOffset],
        set: {
          albumDetailRequests: input.albumDetailRequests,
          anotherPage,
          backfillReleaseCount: input.backfillReleaseCount,
          candidateCount: input.candidateCount,
          durationMs: input.durationMs,
          finishedAt: input.finishedAt,
          itemCount: input.itemCount,
          nextOffset: input.nextOffset,
          requestCount: input.requestCount,
          totalItems: input.totalItems,
        },
      });
    for (const release of input.releases) {
      const summaryHash = spotifyCatalogSummaryHash(release);
      await tx
        .insert(spotifyCatalogReleases)
        .values({
          artistId: input.artistId,
          externalReleaseId: release.externalReleaseId,
          lastObservedAt: input.finishedAt,
          releaseDate: release.releaseDate,
          releaseDatePrecision: release.releaseDatePrecision,
          releaseType: release.releaseType,
          summaryHash,
          title: release.title,
          totalTracks: release.totalTracks,
        })
        .onConflictDoUpdate({
          target: [spotifyCatalogReleases.artistId, spotifyCatalogReleases.externalReleaseId],
          set: {
            lastObservedAt: input.finishedAt,
            releaseDate: release.releaseDate,
            releaseDatePrecision: release.releaseDatePrecision,
            releaseType: release.releaseType,
            summaryHash,
            title: release.title,
            totalTracks: release.totalTracks,
            updatedAt: input.finishedAt,
          },
        });
    }
    const estimatedTotalPages = Math.ceil(input.totalItems / 10);
    if (input.mode === "daily") {
      const current = await tx.query.spotifyArtistCoverage.findFirst({
        where: eq(spotifyArtistCoverage.artistId, input.artistId),
      });
      const retainedCursor = current && current.nextOffset > 0 ? current.nextOffset : 0;
      const remainsPartial = anotherPage || retainedCursor > 0;
      await tx
        .update(spotifyArtistCoverage)
        .set({
          dailyScanCompletedAt: input.finishedAt,
          estimatedTotalPages,
          lastPageScannedAt: input.finishedAt,
          nextOffset: retainedCursor || input.nextOffset || 0,
          partial: remainsPartial,
          status: remainsPartial ? "reconciliation_queued" : "daily_current",
          updatedAt: input.finishedAt,
        })
        .where(eq(spotifyArtistCoverage.artistId, input.artistId));
      return;
    }
    await tx
      .update(spotifyArtistCoverage)
      .set({
        catalogPagesCompleted: existingPage
          ? spotifyArtistCoverage.catalogPagesCompleted
          : sql`${spotifyArtistCoverage.catalogPagesCompleted} + 1`,
        estimatedTotalPages,
        lastFullReconciliationAt: anotherPage ? undefined : input.finishedAt,
        lastPageScannedAt: input.finishedAt,
        nextOffset: input.nextOffset ?? 0,
        pagesScannedInCycle: existingPage
          ? spotifyArtistCoverage.pagesScannedInCycle
          : sql`${spotifyArtistCoverage.pagesScannedInCycle} + 1`,
        partial: anotherPage,
        reconciliationCompletedAt: anotherPage ? null : input.finishedAt,
        status: anotherPage ? "reconciliation_queued" : "fully_reconciled",
        updatedAt: input.finishedAt,
      })
      .where(eq(spotifyArtistCoverage.artistId, input.artistId));
  });
}

export async function markSpotifyCoverageInterrupted(
  db: RadarDatabase,
  input: {
    artistId: string;
    error?: string;
    status: "failed" | "paused" | "rate_limited";
  },
): Promise<void> {
  await db
    .update(spotifyArtistCoverage)
    .set({
      lastReconciliationError: input.error?.slice(0, 500) ?? null,
      partial: true,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(eq(spotifyArtistCoverage.artistId, input.artistId));
}

export async function loadSpotifyCatalogSummaries(db: RadarDatabase): Promise<Map<string, string>> {
  const rows = await db
    .select({
      artistId: spotifyCatalogReleases.artistId,
      externalReleaseId: spotifyCatalogReleases.externalReleaseId,
      summaryHash: spotifyCatalogReleases.summaryHash,
    })
    .from(spotifyCatalogReleases);
  return new Map(
    rows.map((row) => [`${row.artistId}:${row.externalReleaseId}`, row.summaryHash] as const),
  );
}

export async function spotifyCoverageSummary(db: RadarDatabase) {
  const rows = await db.select().from(spotifyArtistCoverage);
  const count = (status: SpotifyCoverageStatus) =>
    rows.filter((row) => row.status === status).length;
  const estimatedRemainingPages = rows.reduce((sum, row) => {
    if (!row.partial || row.estimatedTotalPages === null) return sum;
    return sum + Math.max(0, row.estimatedTotalPages - row.pagesScannedInCycle);
  }, 0);
  return {
    currentCycleCompletedPages: rows.reduce((sum, row) => sum + row.pagesScannedInCycle, 0),
    estimatedRemainingPages,
    estimatedRemainingRequests: estimatedRemainingPages,
    failedArtists: count("failed"),
    fullyReconciledArtists: count("fully_reconciled"),
    inProgressArtists: count("reconciliation_in_progress"),
    partialArtists: rows.filter((row) => row.partial).length,
    pausedArtists: count("paused"),
    queuedArtists: count("reconciliation_queued"),
    rateLimitedArtists: count("rate_limited"),
    totalArtists: rows.length,
  };
}

export async function spotifyCoverageByArtist(db: RadarDatabase, artistIds: string[]) {
  if (artistIds.length === 0) return [];
  return db
    .select()
    .from(spotifyArtistCoverage)
    .where(inArray(spotifyArtistCoverage.artistId, artistIds));
}

export async function pauseSpotifyArtistForBudget(
  db: RadarDatabase,
  artistScanId: string,
): Promise<void> {
  const row = await db.query.spotifyArtistScans.findFirst({
    where: eq(spotifyArtistScans.id, artistScanId),
    columns: { artistId: true, batchId: true },
  });
  if (!row) return;
  await db
    .update(spotifyArtistScans)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(spotifyArtistScans.id, artistScanId), eq(spotifyArtistScans.status, "running")));
  await db
    .update(spotifyScanBatches)
    .set({ pauseRequested: true, status: "paused", updatedAt: new Date() })
    .where(eq(spotifyScanBatches.id, row.batchId));
  await markSpotifyCoverageInterrupted(db, { artistId: row.artistId, status: "paused" });
}

export function spotifyCatalogSummaryHash(summary: SpotifyCatalogReleaseSummary): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        releaseDate: summary.releaseDate,
        releaseDatePrecision: summary.releaseDatePrecision,
        releaseType: summary.releaseType,
        title: summary.title,
        totalTracks: summary.totalTracks,
      }),
    )
    .digest("hex");
}
