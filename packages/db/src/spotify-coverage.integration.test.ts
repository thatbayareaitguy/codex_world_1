import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import {
  pauseSpotifyArtistForBudget,
  prepareSpotifyCoverage,
  recordSpotifyCatalogReleaseSummaries,
  recordSpotifyPage,
  spotifyCoverageSummary,
} from "./spotify-coverage";
import {
  claimNextSpotifyArtist,
  createSpotifyScanBatch,
  finishSpotifyArtistScan,
} from "./spotify-batches";
import { artists, spotifyArtistCoverage, spotifyCatalogReleases, spotifyPageScans } from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

let connection: ReturnType<typeof createDatabase>;
let db: RadarDatabase;

beforeAll(() => {
  connection = createDatabase(databaseUrl);
  db = connection.db;
});

afterAll(async () => {
  await connection.client.end();
});

describe("Spotify resumable catalog coverage", () => {
  it("persists a page cursor across restart and completes the same cycle in a later run", async () => {
    const artistId = await createArtist("Resume");
    const first = await createClaimedScan(artistId);
    const [cycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
      now: new Date("2026-07-21T18:00:00.000Z"),
    });
    expect(cycle?.startOffset).toBe(0);
    await recordPage(first, cycle!.cycleId, 0, 10, 25);

    const restarted = createDatabase(databaseUrl);
    try {
      const [resumed] = await prepareSpotifyCoverage(restarted.db, {
        artistIds: [artistId],
        cycleDays: 30,
        mode: "reconciliation",
        newCycle: false,
      });
      expect(resumed).toMatchObject({ cycleId: cycle!.cycleId, startOffset: 10 });
    } finally {
      await restarted.client.end();
    }

    const second = await createClaimedScan(artistId);
    await recordPage(second, cycle!.cycleId, 10, null, 15);
    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({
      nextOffset: 0,
      pagesScannedInCycle: 2,
      partial: false,
      status: "fully_reconciled",
    });
    expect(coverage?.lastFullReconciliationAt).not.toBeNull();
  });

  it("preserves the deeper cursor when a daily page-one scan runs", async () => {
    const artistId = await createArtist("Daily cursor");
    const reconciliation = await createClaimedScan(artistId);
    const [cycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(reconciliation, cycle!.cycleId, 0, 20, 40);

    const daily = await createClaimedScan(artistId, "daily");
    await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "daily",
      newCycle: false,
    });
    await recordPage(daily, cycle!.cycleId, 0, 10, 40, "daily");

    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({ nextOffset: 20, partial: true });
    expect(coverage?.dailyScanCompletedAt).not.toBeNull();
  });

  it("keeps a retained deep cursor partial when a later daily page one has no next page", async () => {
    const artistId = await createArtist("Daily terminal cursor");
    const reconciliation = await createClaimedScan(artistId);
    const [cycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(reconciliation, cycle!.cycleId, 0, 10, 20);

    const daily = await createClaimedScan(artistId, "daily");
    await recordPage(daily, cycle!.cycleId, 0, null, 10, "daily");

    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({
      nextOffset: 10,
      partial: true,
      status: "reconciliation_queued",
    });
  });

  it("resets only an explicitly new reconciliation cycle to page one", async () => {
    const artistId = await createArtist("Cycle reset");
    const scan = await createClaimedScan(artistId);
    const [firstCycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(scan, firstCycle!.cycleId, 0, 10, 20);

    const [resumed] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: false,
    });
    expect(resumed).toMatchObject({ cycleId: firstCycle!.cycleId, startOffset: 10 });

    const [reset] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    expect(reset?.startOffset).toBe(0);
    expect(reset?.cycleId).not.toBe(firstCycle?.cycleId);
    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({
      catalogPagesCompleted: 0,
      nextOffset: 0,
      pagesScannedInCycle: 0,
      partial: true,
    });
  });

  it("preserves the next unresolved cursor when a request budget pauses work", async () => {
    const artistId = await createArtist("Budget pause");
    const scan = await createClaimedScan(artistId);
    const [cycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(scan, cycle!.cycleId, 0, 10, 30);
    await pauseSpotifyArtistForBudget(db, scan.artistScanId);

    const [resumed] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: false,
    });
    expect(resumed).toMatchObject({ cycleId: cycle!.cycleId, startOffset: 10 });
    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({ nextOffset: 10, partial: true });
  });

  it("retains page history for prior reconciliation cycle ids", async () => {
    const artistId = await createArtist("Cycle history");
    const firstScan = await createClaimedScan(artistId);
    const [firstCycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(firstScan, firstCycle!.cycleId, 0, null, 10);

    const secondScan = await createClaimedScan(artistId);
    const [secondCycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(secondScan, secondCycle!.cycleId, 0, null, 10);

    const pages = await db
      .select({ cycleId: spotifyPageScans.reconciliationCycleId })
      .from(spotifyPageScans)
      .where(eq(spotifyPageScans.artistId, artistId));
    expect(new Set(pages.map((page) => page.cycleId))).toEqual(
      new Set([firstCycle!.cycleId, secondCycle!.cycleId]),
    );
  });

  it("keeps page and catalog writes idempotent", async () => {
    const artistId = await createArtist("Idempotent");
    const scan = await createClaimedScan(artistId);
    const [cycle] = await prepareSpotifyCoverage(db, {
      artistIds: [artistId],
      cycleDays: 30,
      mode: "reconciliation",
      newCycle: true,
    });
    await recordPage(scan, cycle!.cycleId, 0, 10, 20);
    await recordPage(scan, cycle!.cycleId, 0, 10, 20);

    expect(
      await db
        .select()
        .from(spotifyPageScans)
        .where(eq(spotifyPageScans.artistScanId, scan.artistScanId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(spotifyCatalogReleases)
        .where(eq(spotifyCatalogReleases.artistId, artistId)),
    ).toHaveLength(1);
  });

  it("persists simplified catalog summaries independently of page completion", async () => {
    const artistId = await createArtist("Summary persistence");
    const observedAt = new Date("2026-08-08T12:00:00.000Z");
    const release = {
      externalReleaseId: `summary-${randomUUID()}`,
      releaseDate: "2026-08-08",
      releaseDatePrecision: "day",
      releaseType: "single",
      title: "Durable Summary",
      totalTracks: 1,
    };

    await recordSpotifyCatalogReleaseSummaries(db, {
      artistId,
      observedAt,
      releases: [release],
    });

    const restarted = createDatabase(databaseUrl);
    try {
      const persisted = await restarted.db.query.spotifyCatalogReleases.findFirst({
        where: eq(spotifyCatalogReleases.externalReleaseId, release.externalReleaseId),
      });
      expect(persisted).toMatchObject({
        artistId,
        detailsFetchedAt: null,
        lastObservedAt: observedAt,
        title: "Durable Summary",
      });
    } finally {
      await restarted.client.end();
    }
  });

  it("reports partial, queued, and completed provider coverage", async () => {
    const summary = await spotifyCoverageSummary(db);
    expect(summary.totalArtists).toBeGreaterThanOrEqual(3);
    expect(summary.fullyReconciledArtists).toBeGreaterThanOrEqual(1);
    expect(summary.partialArtists).toBeGreaterThanOrEqual(1);
  });

  it("migrates existing partial artist history to a queued next offset", async () => {
    const artistId = await createArtist("Legacy partial");
    const scan = await createClaimedScan(artistId);
    await finishSpotifyArtistScan(db, {
      artistScanId: scan.artistScanId,
      candidateCount: 0,
      pagesScanned: 2,
      requestCount: 2,
      status: "partial",
    });

    await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (artist_id)
          artist_id,
          status,
          pages_scanned,
          finished_at
        FROM spotify_artist_scans
        WHERE status IN ('completed', 'partial')
        ORDER BY artist_id, finished_at DESC NULLS LAST, created_at DESC
      )
      INSERT INTO spotify_artist_coverage (
        artist_id,
        status,
        daily_scan_completed_at,
        next_offset,
        pages_scanned_in_cycle,
        catalog_pages_completed,
        partial,
        last_page_scanned_at,
        last_full_reconciliation_at,
        reconciliation_cycle_id
      )
      SELECT
        artist_id,
        CASE WHEN status = 'partial' THEN 'reconciliation_queued' ELSE 'fully_reconciled' END,
        finished_at,
        CASE WHEN status = 'partial' THEN greatest(pages_scanned, 0) * 10 ELSE 0 END,
        greatest(pages_scanned, 0),
        greatest(pages_scanned, 0),
        status = 'partial',
        finished_at,
        CASE WHEN status = 'completed' THEN finished_at ELSE NULL END,
        CASE WHEN status = 'partial' THEN gen_random_uuid() ELSE NULL END
      FROM latest
      ON CONFLICT (artist_id) DO NOTHING
    `);

    const coverage = await db.query.spotifyArtistCoverage.findFirst({
      where: eq(spotifyArtistCoverage.artistId, artistId),
    });
    expect(coverage).toMatchObject({
      catalogPagesCompleted: 2,
      nextOffset: 20,
      pagesScannedInCycle: 2,
      partial: true,
      status: "reconciliation_queued",
    });
    expect(coverage?.reconciliationCycleId).not.toBeNull();
  });
});

async function createArtist(label: string): Promise<string> {
  const [artist] = await db
    .insert(artists)
    .values({ name: `${label} ${randomUUID()}`, normalizedName: randomUUID() })
    .returning({ id: artists.id });
  if (!artist) throw new Error("Failed to create test artist.");
  return artist.id;
}

async function createClaimedScan(
  artistId: string,
  mode: "daily" | "reconciliation" = "reconciliation",
) {
  const batchId = await createSpotifyScanBatch(db, {
    artists: [{ artistId }],
    confirmationRequired: false,
    estimatedRequests: 2,
    mode,
    pageLimit: 2,
  });
  const scan = await claimNextSpotifyArtist(db, batchId);
  if (!scan) throw new Error("Failed to claim test Spotify artist scan.");
  return { artistId, artistScanId: scan.id, batchId };
}

async function recordPage(
  scan: Awaited<ReturnType<typeof createClaimedScan>>,
  cycleId: string | null,
  offset: number,
  nextOffset: number | null,
  totalItems: number,
  mode: "daily" | "reconciliation" = "reconciliation",
) {
  const now = new Date();
  await recordSpotifyPage(db, {
    albumDetailRequests: 0,
    artistId: scan.artistId,
    artistScanId: scan.artistScanId,
    backfillReleaseCount: 0,
    batchId: scan.batchId,
    candidateCount: 0,
    cycleId,
    dryRun: true,
    durationMs: 1,
    finishedAt: now,
    itemCount: 10,
    mode,
    nextOffset,
    offset,
    pageNumber: Math.floor(offset / 10) + 1,
    releases: [
      {
        detailsFetched: false,
        externalReleaseId: `release-${offset}`,
        releaseDate: "2025-01-01",
        releaseDatePrecision: "day",
        releaseType: "album",
        title: `Catalog page ${offset}`,
        totalTracks: 10,
      },
    ],
    requestCount: 1,
    startedAt: new Date(now.getTime() - 1),
    totalItems,
  });
}
