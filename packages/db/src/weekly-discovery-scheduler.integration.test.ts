import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  claimDiscoveryScheduleAppleJob,
  finishDiscoveryScheduleAppleJob,
  getRecurringDiscoveryScheduleStatus,
  reconcileDiscoveryScheduleJobs,
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
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("weekly discovery scheduler persistence", () => {
  const connection = createDatabase(databaseUrl);

  beforeEach(async () => {
    await connection.db.delete(discoveryScheduleJobs);
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

  it("persists the bootstrap full scan and claims the Friday catch-up after restart", async () => {
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
      scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
      status: "scheduled",
    });

    const claim = await claimDiscoveryScheduleAppleJob(connection.db, now);
    expect(claim).toMatchObject({ jobType: "apple_catchup" });
    expect(
      (await getRecurringDiscoveryScheduleStatus(connection.db, now)).catchup.latest,
    ).toMatchObject({ status: "leased" });
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
      lastAppleScanCompletedAt: new Date("2026-08-07T18:00:00.000Z"),
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
      lastAppleScanCompletedAt: new Date("2026-08-07T18:00:00.000Z"),
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
});
