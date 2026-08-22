import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  activateDiscoverySpotifyPriorityScheduler,
  getDiscoveryScheduleStatus,
  markBroadDiscoveryPlaylistCheckpointPending,
  markDiscoveryPlaylistInboxStatus,
  prepareBroadDiscoveryPlaylistCheckpoint,
  prepareDiscoveryPlaylistInboxExport,
  preparePriorityDiscoveryPlaylistCheckpoint,
  reconcileDiscoveryScheduleAfterCooldown,
  transitionAppleFirstCampaignToRecurringSchedule,
} from "./discovery-schedule";
import {
  artistExternalIds,
  artistFollows,
  artists,
  discoveryReconciliationArtists,
  discoveryReconciliationCampaigns,
  discoveryScheduleState,
  releaseProviderReconciliations,
  spotifyProviderState,
  spotifySchedulerState,
  spotifySchedulerWork,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("first-week discovery schedule transition", () => {
  const connection = createDatabase(databaseUrl);
  const campaignId = randomUUID();
  const userId = randomUUID();
  const artistIds = [randomUUID(), randomUUID(), randomUUID()];
  const now = new Date("2026-08-07T20:00:00.000Z");
  const cooldownUntil = new Date("2026-08-08T18:32:23.000Z");

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.db.insert(users).values({
      displayName: "Schedule Test User",
      email: "schedule@example.test",
      id: userId,
    });
    await connection.db.insert(artists).values(
      artistIds.map((id, index) => ({
        id,
        name: `Schedule Artist ${index + 1}`,
        normalizedName: `schedule artist ${index + 1}`,
      })),
    );
    await connection.db.insert(artistFollows).values(
      artistIds.map((artistId, index) => ({
        artistId,
        followedAt: new Date(now.getTime() + index * 1_000),
        source: "test",
        userId,
      })),
    );
    await connection.db.insert(artistExternalIds).values(
      artistIds.map((artistId, index) => ({
        artistId,
        confirmed: true,
        externalId: `spotify-${index + 1}`,
        provider: "spotify" as const,
        providerUrl: `https://open.spotify.com/artist/${index + 1}`,
      })),
    );
    await connection.db.insert(discoveryReconciliationCampaigns).values({
      appleArtistsScanned: 3,
      campaignKey: "schedule-transition-test",
      effectiveConfiguration: {},
      id: campaignId,
      spotifyCohortSize: 2,
      spotifyPageLimit: 1,
      spotifyRotationSize: 1,
      stage: "internal_reconciliation",
      status: "paused",
      totalArtists: 3,
      windowEnd: "2026-08-07",
      windowStart: "2026-07-08",
    });
    await connection.db.insert(discoveryReconciliationArtists).values([
      {
        appleArtistId: "apple-1",
        appleRecentDiscovery: true,
        appleStatus: "completed",
        artistId: artistIds[0]!,
        campaignId,
        position: 0,
        spotifyArtistId: "spotify-1",
        spotifyStatus: "pending",
      },
      {
        appleArtistId: "apple-2",
        appleStatus: "completed",
        artistId: artistIds[1]!,
        campaignId,
        position: 1,
        spotifyArtistId: "spotify-2",
        spotifyStatus: "partial",
      },
      {
        appleArtistId: "apple-3",
        appleStatus: "completed",
        artistId: artistIds[2]!,
        campaignId,
        position: 2,
        spotifyArtistId: "spotify-3",
        spotifyStatus: "pending",
      },
    ]);
    await connection.db.insert(releaseProviderReconciliations).values({
      appleProviderReleaseId: "apple-release-2",
      artistId: artistIds[1]!,
      campaignId,
      confidence: "1.000",
      reconciliationKey: "unresolved-2",
      releaseDate: "2026-08-06",
      releaseType: "single",
      reasons: ["Apple-only fixture for priority queue validation"],
      status: "apple_only",
      title: "Apple-only release",
    });
    await connection.db
      .insert(spotifyProviderState)
      .values({ cooldownUntil, id: "global" })
      .onConflictDoUpdate({
        target: spotifyProviderState.id,
        set: { cooldownUntil },
      });
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("preserves partial progress and creates separate priority and rolling queues", async () => {
    const first = await transitionAppleFirstCampaignToRecurringSchedule(
      connection.db,
      campaignId,
      now,
    );
    await expect(
      prepareDiscoveryPlaylistInboxExport(connection.db, campaignId, now),
    ).rejects.toThrow("Spotify cooldown remains active");
    const repeated = await transitionAppleFirstCampaignToRecurringSchedule(
      connection.db,
      campaignId,
      new Date(now.getTime() + 60_000),
    );

    expect(first).toMatchObject({
      applePriorityQueued: 2,
      broadSpotifyQueued: 2,
      campaignStatus: "completed_with_spotify_deferred",
      phase: "cooldown_wait",
    });
    expect(repeated.nextAppleScanAt).toEqual(first.nextAppleScanAt);
    await expect(reconcileDiscoveryScheduleAfterCooldown(connection.db, now)).resolves.toBe(false);
    await expect(
      reconcileDiscoveryScheduleAfterCooldown(connection.db, new Date(cooldownUntil.getTime() + 1)),
    ).resolves.toBe(true);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });
    await prepareDiscoveryPlaylistInboxExport(
      connection.db,
      campaignId,
      new Date(cooldownUntil.getTime() + 1),
    );
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaignId),
      }),
    ).toMatchObject({
      deferredSpotifyArtistCount: 2,
      stage: "completed",
      status: "completed_with_spotify_deferred",
    });
    expect(
      await connection.db
        .select()
        .from(spotifySchedulerWork)
        .where(eq(spotifySchedulerWork.source, "apple_priority")),
    ).toHaveLength(2);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      applePriorityQueuedCount: 2,
      broadSpotifyQueuedCount: 2,
      phase: "playlist_inbox",
      playlistInboxStatus: "exporting",
    });
    expect(
      await connection.db.query.discoveryReconciliationArtists.findFirst({
        where: eq(discoveryReconciliationArtists.artistId, artistIds[2]!),
      }),
    ).toMatchObject({ spotifyStatus: "pending" });

    await expect(
      activateDiscoverySpotifyPriorityScheduler(connection.db, campaignId, now),
    ).rejects.toThrow("playlist inbox must complete");
    await markDiscoveryPlaylistInboxStatus(connection.db, { status: "completed" }, now);
    expect(
      await transitionAppleFirstCampaignToRecurringSchedule(
        connection.db,
        campaignId,
        new Date(now.getTime() + 120_000),
      ),
    ).toMatchObject({ phase: "apple_priority" });
    await expect(
      activateDiscoverySpotifyPriorityScheduler(connection.db, campaignId, now),
    ).rejects.toThrow("Spotify cooldown remains active");
    await activateDiscoverySpotifyPriorityScheduler(
      connection.db,
      campaignId,
      new Date(cooldownUntil.getTime() + 1),
    );
    expect(
      await connection.db.query.spotifySchedulerState.findFirst({
        where: eq(spotifySchedulerState.id, "global"),
      }),
    ).toMatchObject({ mode: "automatic" });
  });

  it("batches broad discoveries into one restart-safe playlist checkpoint", async () => {
    const checkpointAt = new Date("2026-08-08T22:00:00.000Z");
    await connection.db
      .update(spotifyProviderState)
      .set({ cooldownUntil: null })
      .where(eq(spotifyProviderState.id, "global"));
    await connection.db
      .update(discoveryScheduleState)
      .set({ phase: "broad_spotify", playlistInboxStatus: "completed" })
      .where(eq(discoveryScheduleState.id, "global"));

    await expect(
      markBroadDiscoveryPlaylistCheckpointPending(connection.db, checkpointAt),
    ).resolves.toBe(true);
    await expect(
      markBroadDiscoveryPlaylistCheckpointPending(connection.db, checkpointAt),
    ).resolves.toBe(false);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      phase: "broad_spotify",
      playlistInboxStatus: "pending",
    });

    await expect(
      prepareBroadDiscoveryPlaylistCheckpoint(connection.db, checkpointAt),
    ).resolves.toBe(true);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });

    await connection.db
      .update(discoveryScheduleState)
      .set({ phase: "broad_spotify", playlistInboxStatus: "pending" })
      .where(eq(discoveryScheduleState.id, "global"));
    await connection.db
      .update(spotifyProviderState)
      .set({ cooldownUntil: new Date(checkpointAt.getTime() + 60_000) })
      .where(eq(spotifyProviderState.id, "global"));
    await expect(
      prepareBroadDiscoveryPlaylistCheckpoint(connection.db, checkpointAt),
    ).resolves.toBe(true);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      phase: "cooldown_wait",
      playlistInboxStatus: "ready",
    });
  });

  it("opens a guarded playlist checkpoint without discarding remaining priority work", async () => {
    const checkpointAt = new Date("2026-08-22T06:45:00.000Z");
    await connection.db
      .update(discoveryScheduleState)
      .set({ phase: "apple_priority", playlistInboxStatus: "pending" })
      .where(eq(discoveryScheduleState.id, "global"));

    await expect(
      preparePriorityDiscoveryPlaylistCheckpoint(connection.db, checkpointAt),
    ).resolves.toBe(true);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state).toMatchObject({
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });
    await expect(
      preparePriorityDiscoveryPlaylistCheckpoint(connection.db, checkpointAt),
    ).resolves.toBe(false);

    await markDiscoveryPlaylistInboxStatus(connection.db, { status: "completed" }, checkpointAt);
    expect((await getDiscoveryScheduleStatus(connection.db))?.state.phase).toBe("apple_priority");
  });
});
