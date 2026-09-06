import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  attachDiscoveryScheduleAppleJobBatch,
  claimDiscoveryScheduleAppleJob,
  finishDiscoveryScheduleAppleJob,
  getRecurringDiscoveryScheduleStatus,
  reconcileDiscoveryScheduleJobs,
  yieldDiscoveryScheduleAppleJob,
} from "./discovery-schedule";
import {
  appleMusicArtistScans,
  appleMusicScanBatches,
  artistExternalIds,
  artists,
  discoveryScheduleJobs,
  discoveryScheduleState,
  spotifyProviderState,
  spotifyRequestEvents,
  spotifySchedulerDailyArtists,
  spotifySchedulerState,
  spotifySchedulerWork,
  scanRuns,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("weekly discovery scheduler persistence", () => {
  const connection = createDatabase(databaseUrl);

  beforeEach(async () => {
    await connection.db.delete(discoveryScheduleJobs);
    await connection.db.delete(appleMusicArtistScans);
    await connection.db.delete(appleMusicScanBatches);
    await connection.db.delete(discoveryScheduleState);
    await connection.db.delete(spotifySchedulerDailyArtists);
    await connection.db.delete(spotifySchedulerWork);
    await connection.db.delete(spotifySchedulerState);
    await connection.db.delete(spotifyRequestEvents);
    await connection.db.delete(spotifyProviderState);
  });

  afterAll(async () => {
    await connection.db.delete(discoveryScheduleJobs);
    await connection.db.delete(discoveryScheduleState);
    await connection.client.end();
  });

  it("does not duplicate Friday catch-up after a later full scan completed", async () => {
    const now = new Date("2026-08-07T19:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T18:00:00.000Z"),
      phase: "broad_spotify",
    });

    await reconcileDiscoveryScheduleJobs(connection.db, now);
    const beforeRestart = await getRecurringDiscoveryScheduleStatus(connection.db, now);
    const afterRestart = await getRecurringDiscoveryScheduleStatus(connection.db, now);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.full.latest).toMatchObject({ status: "completed" });
    expect(afterRestart.catchup.latest).toMatchObject({
      errorClassification: "covered_by_later_full_scan",
      scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
      status: "completed",
    });
    expect(await claimDiscoveryScheduleAppleJob(connection.db, now)).toBeNull();
  });

  it("expires missed jobs after 24 hours and never stacks old jobs for execution", async () => {
    const now = new Date("2026-08-09T19:00:00.000Z");
    await reconcileDiscoveryScheduleJobs(connection.db, now);
    const status = await getRecurringDiscoveryScheduleStatus(connection.db, now);
    expect(status.full.latest?.status).toBe("expired");
    expect(status.catchup.latest?.status).toBe("expired");
    expect(await claimDiscoveryScheduleAppleJob(connection.db, now)).toBeNull();
    const dueScheduled = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(discoveryScheduleJobs)
      .where(
        and(
          eq(discoveryScheduleJobs.status, "scheduled"),
          lte(discoveryScheduleJobs.scheduledFor, now),
        ),
      );
    expect(Number(dueScheduled[0]?.count ?? 0)).toBe(0);
  });

  it("queues Friday discoveries separately and preserves the completed job", async () => {
    const now = new Date("2026-08-07T19:00:00.000Z");
    const artistId = randomUUID();
    await connection.db.insert(artists).values({
      id: artistId,
      name: "Catch-up Artist",
      normalizedName: `catch-up-${artistId}`,
    });
    await connection.db.insert(artistExternalIds).values({
      artistId,
      confirmed: true,
      externalId: `spotify-${artistId}`,
      provider: "spotify",
    });
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T15:00:00.000Z"),
      phase: "broad_spotify",
    });
    await reconcileDiscoveryScheduleJobs(connection.db, now);
    const claim = await claimDiscoveryScheduleAppleJob(connection.db, now);
    expect(claim?.jobType).toBe("apple_catchup");
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        completedArtists: 1,
        finishedAt: now,
        startedAt: new Date(now.getTime() - 60_000),
        status: "completed",
        totalArtists: 1,
      })
      .returning({ id: appleMusicScanBatches.id });
    await connection.db.insert(appleMusicArtistScans).values({
      artistId,
      batchId: batch!.id,
      candidateCount: 2,
      finishedAt: now,
      position: 0,
      providerArtistId: `apple-${artistId}`,
      status: "completed",
      windowEnd: "2026-08-07",
      windowStart: "2026-08-06",
    });

    expect(
      await finishDiscoveryScheduleAppleJob(
        connection.db,
        claim!,
        { appleMusicBatchId: batch!.id, status: "completed" },
        now,
      ),
    ).toBe(true);
    const queued = await connection.db.query.spotifySchedulerWork.findFirst({
      where: eq(spotifySchedulerWork.source, "apple_catchup"),
    });
    expect(queued).toMatchObject({ artistId, status: "queued" });
    const status = await getRecurringDiscoveryScheduleStatus(connection.db, now);
    expect(status.catchup.latest).toMatchObject({
      appleMusicBatchId: batch!.id,
      status: "completed",
    });
    expect(status).toMatchObject({
      phase: "apple_catchup_priority",
      playlistInbox: { pendingCount: 0, status: "pending" },
    });
  });

  it("moves a completed Apple job with no priority work directly to automatic export", async () => {
    const now = new Date("2026-08-07T19:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T15:00:00.000Z"),
      phase: "broad_spotify",
    });
    await reconcileDiscoveryScheduleJobs(connection.db, now);
    const claim = await claimDiscoveryScheduleAppleJob(connection.db, now);
    expect(claim?.jobType).toBe("apple_catchup");
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        completedArtists: 1,
        finishedAt: now,
        startedAt: new Date(now.getTime() - 60_000),
        status: "completed",
        totalArtists: 1,
      })
      .returning({ id: appleMusicScanBatches.id });

    expect(
      await finishDiscoveryScheduleAppleJob(
        connection.db,
        claim!,
        { appleMusicBatchId: batch!.id, status: "completed" },
        now,
      ),
    ).toBe(true);
    expect(await getRecurringDiscoveryScheduleStatus(connection.db, now)).toMatchObject({
      phase: "playlist_inbox",
      playlistInbox: { status: "ready" },
    });
  });

  it("reconnects an orphaned failed schedule job to its existing resumable batch", async () => {
    const scheduledFor = new Date("2026-08-07T16:00:00.000Z");
    const recoveryDeadline = new Date("2026-08-08T16:00:00.000Z");
    const [run] = await connection.db
      .insert(scanRuns)
      .values({ provider: "apple_music", providersRequested: ["apple_music"], status: "paused" })
      .returning({ id: scanRuns.id });
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        createdAt: new Date("2026-08-07T19:00:00.000Z"),
        scanRunId: run!.id,
        status: "paused",
        totalArtists: 580,
      })
      .returning({ id: appleMusicScanBatches.id });
    await connection.db.insert(discoveryScheduleJobs).values({
      errorClassification: "scheduled_apple_scan_failed",
      jobKey: "apple_catchup:2026-08-07",
      jobType: "apple_catchup",
      recoveryDeadline,
      scheduledFor,
      status: "failed",
    });

    const afterDeadline = new Date("2026-08-09T01:00:00.000Z");
    await reconcileDiscoveryScheduleJobs(connection.db, afterDeadline);
    const resumed = await claimDiscoveryScheduleAppleJob(connection.db, afterDeadline);
    expect(resumed).toMatchObject({
      appleMusicBatchId: batch!.id,
      jobKey: "apple_catchup:2026-08-07",
      scanRunId: run!.id,
    });
  });

  it("yields a runtime-limited Apple job and resumes the same batch and scan run", async () => {
    const started = new Date("2026-08-07T19:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T15:00:00.000Z"),
      phase: "broad_spotify",
    });
    await reconcileDiscoveryScheduleJobs(connection.db, started);
    const firstClaim = await claimDiscoveryScheduleAppleJob(connection.db, started);
    expect(firstClaim?.jobType).toBe("apple_catchup");
    const [run] = await connection.db
      .insert(scanRuns)
      .values({ provider: "apple_music", providersRequested: ["apple_music"] })
      .returning({ id: scanRuns.id });
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({ scanRunId: run!.id, status: "paused", totalArtists: 580 })
      .returning({ id: appleMusicScanBatches.id });
    expect(
      await attachDiscoveryScheduleAppleJobBatch(connection.db, firstClaim!, {
        appleMusicBatchId: batch!.id,
        scanRunId: run!.id,
      }),
    ).toBe(true);
    expect(
      await yieldDiscoveryScheduleAppleJob(connection.db, firstClaim!, {
        appleMusicBatchId: batch!.id,
        errorClassification: "runtime_budget_exhausted",
        scanRunId: run!.id,
      }),
    ).toBe(true);

    const afterOriginalDeadline = new Date("2026-08-09T01:00:00.000Z");
    const resumed = await claimDiscoveryScheduleAppleJob(connection.db, afterOriginalDeadline);
    expect(resumed).toMatchObject({
      appleMusicBatchId: batch!.id,
      id: firstClaim!.id,
      scanRunId: run!.id,
    });
    const jobs = await connection.db
      .select({ id: discoveryScheduleJobs.id })
      .from(discoveryScheduleJobs)
      .where(eq(discoveryScheduleJobs.appleMusicBatchId, batch!.id));
    expect(jobs).toHaveLength(1);
  });
});
