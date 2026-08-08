import {
  createDatabase,
  operationLocks,
  spotifyProviderState,
  spotifyRequestEvents,
  spotifySchedulerWork,
  discoveryScheduleState,
  type executeSpotifyPlaylistExport,
  type SpotifyPlaylistExportExecution,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutomaticDiscoveryPlaylistExport } from "./spotify-playlist-export-runtime";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const playlistId = "4l6LaMPL6duulmFe3hRR4Y";

describe.sequential("automatic discovery playlist export", () => {
  const connection = createDatabase(databaseUrl);

  beforeEach(async () => {
    await connection.db.delete(operationLocks);
    await connection.db.delete(discoveryScheduleState);
    await connection.db.delete(spotifySchedulerWork);
    await connection.db.delete(spotifyRequestEvents);
    await connection.db.delete(spotifyProviderState);
  });

  afterAll(async () => {
    await connection.db.delete(operationLocks);
    await connection.db.delete(discoveryScheduleState);
    await connection.client.end();
  });

  it("runs after restart against only the configured playlist even when Artist Albums is exhausted", async () => {
    const now = new Date();
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      phase: "playlist_inbox",
      playlistInboxStatus: "exporting",
    });
    await connection.db.insert(spotifyRequestEvents).values(
      Array.from({ length: 80 }, (_, index) => ({
        endpointCategory: "artist_albums",
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - index * 1_000),
        status: 200,
      })),
    );
    const runId = randomUUID();
    const executeExport: typeof executeSpotifyPlaylistExport = vi.fn(
      (_db, _userId, _client, input) => {
        expect(input).toMatchObject({
          orderingPolicy: "discovery_inbox",
          playlistId,
          policy: { allowedPlaylistId: playlistId, enabled: true },
        });
        return Promise.resolve(completedExecution(runId));
      },
    );

    const restarted = createDatabase(databaseUrl);
    try {
      await expect(
        runAutomaticDiscoveryPlaylistExport(restarted.db, configuration(), { executeExport }),
      ).resolves.toMatchObject({ reason: "completed", runId });
    } finally {
      await restarted.client.end();
    }

    expect(executeExport).toHaveBeenCalledTimes(1);
    expect(
      await connection.db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({
      phase: "broad_spotify",
      playlistInboxExportRunId: runId,
      playlistInboxStatus: "completed",
    });
    expect(await connection.db.select().from(operationLocks)).toHaveLength(0);
  });

  it("preserves a ready export without calling Spotify during a provider cooldown", async () => {
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });
    await connection.db.insert(spotifyProviderState).values({
      cooldownUntil: new Date(Date.now() + 60 * 60_000),
      id: "global",
    });
    const executeExport: typeof executeSpotifyPlaylistExport = vi.fn(() =>
      Promise.resolve(completedExecution(randomUUID())),
    );

    await expect(
      runAutomaticDiscoveryPlaylistExport(connection.db, configuration(), { executeExport }),
    ).resolves.toEqual({ reason: "not_due" });
    expect(executeExport).not.toHaveBeenCalled();
    expect(
      await connection.db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "playlist_inbox", playlistInboxStatus: "ready" });
    expect(await connection.db.select().from(operationLocks)).toHaveLength(0);
  });

  it("does not duplicate an exporting checkpoint while its operation lock is active", async () => {
    const now = new Date();
    await connection.db.insert(discoveryScheduleState).values({
      id: "global",
      phase: "playlist_inbox",
      playlistInboxStatus: "exporting",
    });
    await connection.db.insert(operationLocks).values({
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      lockKey: "spotify:playlist-export",
      operationType: "spotify_playlist_export",
      ownerToken: randomUUID(),
    });
    const executeExport: typeof executeSpotifyPlaylistExport = vi.fn(() =>
      Promise.resolve(completedExecution(randomUUID())),
    );

    await expect(
      runAutomaticDiscoveryPlaylistExport(connection.db, configuration(), { executeExport }),
    ).rejects.toThrow("already running");
    expect(executeExport).not.toHaveBeenCalled();
    expect(
      await connection.db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "playlist_inbox", playlistInboxStatus: "exporting" });
  });
});

function configuration() {
  return loadProviderConfiguration({
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    MUSICBRAINZ_ENABLED: "false",
    REDDIT_ENABLED: "false",
    SPOTIFY_ALLOWED_PLAYLIST_ID: playlistId,
    SPOTIFY_CLIENT_ID: "test-client-id",
    SPOTIFY_CLIENT_SECRET: "test-client-secret",
    SPOTIFY_ENABLED: "true",
    SPOTIFY_PLAYLIST_WRITES_ENABLED: "true",
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/spotify/callback",
  });
}

function completedExecution(runId: string): SpotifyPlaylistExportExecution {
  return {
    plan: {
      additions: [],
      alreadyPresent: [],
      desired: [],
      existingDuplicateTrackIds: [],
      finalTrackIds: [],
      orderingConflicts: [],
      releaseGroupingConflicts: [],
      skips: [],
      unrelatedItems: [],
    },
    run: {
      additionsAttempted: 0,
      exported: 0,
      failed: 0,
      id: runId,
      pending: 0,
      resumed: false,
      skipped: 0,
      status: "completed",
    },
    target: {
      collaborative: false,
      id: playlistId,
      idAbbreviated: "4l6L...hRR4",
      name: "Release Inbox",
      ownerId: "owner",
      private: true,
      snapshotId: "snapshot",
    },
  };
}
