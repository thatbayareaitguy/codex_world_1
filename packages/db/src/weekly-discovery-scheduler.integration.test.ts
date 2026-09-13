import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  attachDiscoveryScheduleAppleJobBatch,
  claimDiscoveryScheduleAppleJob,
  discoveryAppleJobLeaseMs,
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

  it("marks an unstarted failed catch-up complete when a later full scan covered it", async () => {
    const scheduledFor = new Date("2026-08-07T16:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T18:00:00.000Z"),
      phase: "broad_spotify",
    });
    await connection.db.insert(discoveryScheduleJobs).values({
      errorClassification: "scheduled_apple_scan_failed",
      jobKey: "apple_catchup:2026-08-07",
      jobType: "apple_catchup",
      recoveryDeadline: new Date("2026-08-08T16:00:00.000Z"),
      scheduledFor,
      status: "failed",
    });

    await reconcileDiscoveryScheduleJobs(connection.db, new Date("2026-08-07T19:00:00.000Z"));

    const job = await connection.db.query.discoveryScheduleJobs.findFirst({
      where: eq(discoveryScheduleJobs.jobKey, "apple_catchup:2026-08-07"),
    });
    expect(job).toMatchObject({
      completedAt: new Date("2026-08-07T18:00:00.000Z"),
      errorClassification: "covered_by_later_full_scan",
      status: "completed",
    });
  });

  it("does not claim catch-up while an earlier full scan is leased", async () => {
    const now = new Date("2026-08-07T19:00:00.000Z");
    await reconcileDiscoveryScheduleJobs(connection.db, now);

    const fullClaim = await claimDiscoveryScheduleAppleJob(connection.db, now);
    expect(fullClaim?.jobType).toBe("apple_full");
    expect(fullClaim!.leaseExpiresAt.getTime() - now.getTime()).toBe(discoveryAppleJobLeaseMs);
    expect(discoveryAppleJobLeaseMs).toBeGreaterThan(3.5 * 60 * 60_000);
    await expect(claimDiscoveryScheduleAppleJob(connection.db, now)).resolves.toBeNull();
    await expect(
      claimDiscoveryScheduleAppleJob(
        connection.db,
        new Date(now.getTime() + 3 * 60 * 60_000 + 60_000),
      ),
    ).resolves.toBeNull();
    const reclaimed = await claimDiscoveryScheduleAppleJob(
      connection.db,
      new Date(now.getTime() + discoveryAppleJobLeaseMs + 60_000),
    );
    expect(reclaimed).toMatchObject({ id: fullClaim!.id, jobType: "apple_full" });
  });

  it("reclaims an Apple schedule lease immediately when its local owner process is dead", async () => {
    const started = new Date("2026-08-07T19:00:00.000Z");
    await reconcileDiscoveryScheduleJobs(connection.db, started);
    const firstClaim = await claimDiscoveryScheduleAppleJob(connection.db, started);
    expect(firstClaim).not.toBeNull();
    await connection.db
      .update(discoveryScheduleJobs)
      .set({ leaseOwner: "local-pid:2147483647:00000000-0000-0000-0000-000000000000" })
      .where(eq(discoveryScheduleJobs.id, firstClaim!.id));

    const recoveredAt = new Date(started.getTime() + 7 * 60_000);
    await reconcileDiscoveryScheduleJobs(connection.db, recoveredAt);
    const recovered = await claimDiscoveryScheduleAppleJob(connection.db, recoveredAt);

    expect(recovered).toMatchObject({ id: firstClaim!.id, jobType: firstClaim!.jobType });
    expect(recovered!.leaseExpiresAt.getTime() - recoveredAt.getTime()).toBe(
      discoveryAppleJobLeaseMs,
    );
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
      .values({
        provider: "apple_music",
        providersRequested: ["apple_music"],
        status: "paused",
        triggerType: "apple_catchup_scheduled",
      })
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

  it("reclaims a linked expired schedule job when its resumable batch still needs finalization", async () => {
    const scheduledFor = new Date("2026-08-07T16:00:00.000Z");
    const [run] = await connection.db
      .insert(scanRuns)
      .values({ provider: "apple_music", providersRequested: ["apple_music"], status: "partial" })
      .returning({ id: scanRuns.id });
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        completedArtists: 1,
        failedArtists: 0,
        finishedAt: new Date("2026-08-07T19:00:00.000Z"),
        scanRunId: run!.id,
        status: "partial",
        totalArtists: 1,
      })
      .returning({ id: appleMusicScanBatches.id });
    await connection.db.insert(discoveryScheduleJobs).values({
      appleMusicBatchId: batch!.id,
      errorClassification: "scheduled_apple_scan_failed",
      jobKey: "apple_catchup:2026-08-07",
      jobType: "apple_catchup",
      recoveryDeadline: new Date("2026-08-08T16:00:00.000Z"),
      scanRunId: run!.id,
      scheduledFor,
      status: "expired",
    });

    const afterDeadline = new Date("2026-08-09T01:00:00.000Z");
    await reconcileDiscoveryScheduleJobs(connection.db, afterDeadline);
    expect(await claimDiscoveryScheduleAppleJob(connection.db, afterDeadline)).toMatchObject({
      appleMusicBatchId: batch!.id,
      jobKey: "apple_catchup:2026-08-07",
      scanRunId: run!.id,
    });
  });

  it("reports an older linked Apple workflow as actionable after a newer occurrence exists", async () => {
    const [run] = await connection.db
      .insert(scanRuns)
      .values({
        provider: "apple_music",
        providersRequested: ["apple_music"],
        status: "paused",
        triggerType: "apple_catchup_scheduled",
      })
      .returning({ id: scanRuns.id });
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({ scanRunId: run!.id, status: "paused", totalArtists: 593 })
      .returning({ id: appleMusicScanBatches.id });
    await connection.db.insert(discoveryScheduleJobs).values([
      {
        appleMusicBatchId: batch!.id,
        jobKey: "apple_catchup:2026-08-07",
        jobType: "apple_catchup",
        recoveryDeadline: new Date("2026-08-08T16:00:00.000Z"),
        scanRunId: run!.id,
        scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
        status: "scheduled",
      },
      {
        completedAt: new Date("2026-08-14T18:00:00.000Z"),
        jobKey: "apple_catchup:2026-08-14",
        jobType: "apple_catchup",
        recoveryDeadline: new Date("2026-08-15T16:00:00.000Z"),
        scheduledFor: new Date("2026-08-14T16:00:00.000Z"),
        status: "completed",
      },
    ]);

    const status = await getRecurringDiscoveryScheduleStatus(
      connection.db,
      new Date("2026-08-15T19:00:00.000Z"),
    );
    expect(status.actionable).toMatchObject({
      appleMusicBatchId: batch!.id,
      scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
      status: "scheduled",
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

  it("yields an Apple claim before a batch exists without failing the schedule job", async () => {
    const started = new Date("2026-08-07T19:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T15:00:00.000Z"),
      phase: "broad_spotify",
    });
    await reconcileDiscoveryScheduleJobs(connection.db, started);
    const firstClaim = await claimDiscoveryScheduleAppleJob(connection.db, started);
    expect(firstClaim).toMatchObject({
      appleMusicBatchId: null,
      jobType: "apple_catchup",
      scanRunId: null,
    });

    expect(
      await yieldDiscoveryScheduleAppleJob(
        connection.db,
        firstClaim!,
        {
          appleMusicBatchId: null,
          errorClassification: "apple_scan_lock_contended",
          scanRunId: null,
        },
        started,
      ),
    ).toBe(true);

    const yielded = await connection.db.query.discoveryScheduleJobs.findFirst({
      where: eq(discoveryScheduleJobs.id, firstClaim!.id),
    });
    expect(yielded).toMatchObject({
      appleMusicBatchId: null,
      errorClassification: "apple_scan_lock_contended",
      leaseExpiresAt: null,
      leaseOwner: null,
      scanRunId: null,
      status: "scheduled",
    });
  });

  it("recovers an orphaned batch created just before an Apple schedule attachment crash", async () => {
    const started = new Date("2026-08-07T19:00:00.000Z");
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      lastAppleScanCompletedAt: new Date("2026-08-07T15:00:00.000Z"),
      phase: "broad_spotify",
    });
    await reconcileDiscoveryScheduleJobs(connection.db, started);
    const firstClaim = await claimDiscoveryScheduleAppleJob(connection.db, started);
    const [run] = await connection.db
      .insert(scanRuns)
      .values({
        provider: "apple_music",
        providersRequested: ["apple_music"],
        status: "paused",
        triggerType: "apple_catchup_scheduled",
      })
      .returning({ id: scanRuns.id });
    const [orphanedBatch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        createdAt: new Date(started.getTime() + 1_000),
        scanRunId: run!.id,
        status: "paused",
        totalArtists: 593,
      })
      .returning({ id: appleMusicScanBatches.id });

    const afterLeaseExpiry = new Date(started.getTime() + discoveryAppleJobLeaseMs + 1_000);
    await reconcileDiscoveryScheduleJobs(connection.db, afterLeaseExpiry);
    const resumed = await claimDiscoveryScheduleAppleJob(connection.db, afterLeaseExpiry);

    expect(resumed).toMatchObject({
      appleMusicBatchId: orphanedBatch!.id,
      id: firstClaim!.id,
      scanRunId: run!.id,
    });
    const jobs = await connection.db
      .select({ id: discoveryScheduleJobs.id })
      .from(discoveryScheduleJobs)
      .where(eq(discoveryScheduleJobs.appleMusicBatchId, orphanedBatch!.id));
    expect(jobs).toHaveLength(1);
  });
});
