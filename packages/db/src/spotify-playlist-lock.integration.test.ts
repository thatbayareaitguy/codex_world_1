import type { SpotifyClient } from "@radar/providers";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./client";
import { operationLocks } from "./schema";
import {
  acquireSpotifyPlaylistWriterLock,
  guardSpotifyPlaylistWriterClient,
  releaseSpotifyPlaylistWriterLock,
  spotifyPlaylistWriterFallbackTtlMs,
  spotifyPlaylistWriterLockKey,
  SpotifyPlaylistWriterOwnershipError,
} from "./spotify-playlist-lock";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Spotify playlist writer lock", () => {
  const connection = createDatabase(databaseUrl);

  beforeEach(async () => {
    await connection.db.delete(operationLocks);
  });

  afterAll(async () => {
    await connection.db.delete(operationLocks);
    await connection.client.end();
  });

  it("does not renew another owner's fresh lease", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await insertLock({ expiresAt, heartbeatAt: now, ownerPid: 41 });

    await expect(
      acquireSpotifyPlaylistWriterLock(connection.db, {
        inspectProcess: () => "alive",
        now,
        ownerHost: "test-host",
      }),
    ).rejects.toThrow("already running");

    await expect(loadLock()).resolves.toMatchObject({ expiresAt });
  });

  it("reclaims a stale live-PID lease after one observation without a heartbeat", async () => {
    const now = new Date();
    await insertLock({
      heartbeatAt: new Date(now.getTime() - spotifyPlaylistWriterFallbackTtlMs - 1),
      ownerPid: 42,
    });
    const waitForHeartbeatObservation = vi.fn(() => Promise.resolve());

    const acquired = await acquireSpotifyPlaylistWriterLock(connection.db, {
      inspectProcess: () => "alive",
      now,
      ownerHost: "test-host",
      waitForHeartbeatObservation,
    });

    expect(waitForHeartbeatObservation).toHaveBeenCalledOnce();
    expect((await loadLock())?.ownerToken).toBe(acquired.ownerToken);
    await releaseSpotifyPlaylistWriterLock(connection.db, acquired);
  });

  it("protects a stale live-PID lease when its heartbeat advances during observation", async () => {
    const now = new Date();
    const ownerToken = await insertLock({
      heartbeatAt: new Date(now.getTime() - spotifyPlaylistWriterFallbackTtlMs - 1),
      ownerPid: 43,
    });

    await expect(
      acquireSpotifyPlaylistWriterLock(connection.db, {
        inspectProcess: () => "alive",
        now,
        ownerHost: "test-host",
        waitForHeartbeatObservation: async () => {
          await connection.db
            .update(operationLocks)
            .set({
              metadata: {
                heartbeatAt: now.toISOString(),
                ownerHost: "test-host",
                ownerPid: 43,
              },
            })
            .where(eq(operationLocks.ownerToken, ownerToken));
        },
      }),
    ).rejects.toThrow("already running");
    expect((await loadLock())?.ownerToken).toBe(ownerToken);
  });

  it("marks release intent before deletion so a failed delete is immediately reclaimable", async () => {
    const lock = await acquireSpotifyPlaylistWriterLock(connection.db, {
      ownerHost: "test-host",
      ownerPid: 44,
    });

    await expect(
      releaseSpotifyPlaylistWriterLock(connection.db, lock, {
        releaseLock: () => Promise.reject(new Error("simulated delete failure")),
      }),
    ).rejects.toThrow("simulated delete failure");
    const releaseRequestedLock = await loadLock();
    expect(releaseRequestedLock?.ownerToken).toBe(lock.ownerToken);
    expect(releaseRequestedLock?.metadata).toMatchObject({ releaseRequested: true });

    const replacement = await acquireSpotifyPlaylistWriterLock(connection.db, {
      inspectProcess: () => "alive",
      ownerHost: "test-host",
      ownerPid: 45,
      waitForHeartbeatObservation: () => Promise.resolve(),
    });
    expect(replacement.ownerToken).not.toBe(lock.ownerToken);
    await releaseSpotifyPlaylistWriterLock(connection.db, replacement);
  });

  it("fences every playlist mutation after ownership is lost", async () => {
    const lock = await acquireSpotifyPlaylistWriterLock(connection.db);
    const client = {
      addPlaylistItemsAtPosition: vi.fn<SpotifyClient["addPlaylistItemsAtPosition"]>(() =>
        Promise.resolve("snapshot-add"),
      ),
      reorderPlaylistItems: vi.fn<SpotifyClient["reorderPlaylistItems"]>(() =>
        Promise.resolve("snapshot-order"),
      ),
      setAuthorizedPlaylistPublic: vi.fn<SpotifyClient["setAuthorizedPlaylistPublic"]>(() =>
        Promise.resolve(),
      ),
    };
    const guarded = guardSpotifyPlaylistWriterClient(connection.db, lock, client);

    await expect(guarded.addPlaylistItemsAtPosition("playlist", ["track"], 0)).resolves.toBe(
      "snapshot-add",
    );
    await expect(
      guarded.reorderPlaylistItems("playlist", {
        insertBefore: 0,
        rangeLength: 1,
        rangeStart: 1,
        snapshotId: "snapshot-add",
      }),
    ).resolves.toBe("snapshot-order");
    await expect(guarded.setAuthorizedPlaylistPublic("playlist")).resolves.toBeUndefined();

    await connection.db
      .delete(operationLocks)
      .where(eq(operationLocks.ownerToken, lock.ownerToken));

    await expect(
      guarded.addPlaylistItemsAtPosition("playlist", ["track"], 0),
    ).rejects.toBeInstanceOf(SpotifyPlaylistWriterOwnershipError);
    await expect(
      guarded.reorderPlaylistItems("playlist", {
        insertBefore: 0,
        rangeLength: 1,
        rangeStart: 1,
        snapshotId: "snapshot-order",
      }),
    ).rejects.toBeInstanceOf(SpotifyPlaylistWriterOwnershipError);
    await expect(guarded.setAuthorizedPlaylistPublic("playlist")).rejects.toBeInstanceOf(
      SpotifyPlaylistWriterOwnershipError,
    );
    expect(client.addPlaylistItemsAtPosition).toHaveBeenCalledOnce();
    expect(client.reorderPlaylistItems).toHaveBeenCalledOnce();
    expect(client.setAuthorizedPlaylistPublic).toHaveBeenCalledOnce();
  });

  async function insertLock(input: {
    expiresAt?: Date;
    heartbeatAt: Date;
    ownerPid: number;
  }): Promise<string> {
    const ownerToken = randomUUID();
    await connection.db.insert(operationLocks).values({
      acquiredAt: input.heartbeatAt,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 60 * 60_000),
      lockKey: spotifyPlaylistWriterLockKey,
      metadata: {
        heartbeatAt: input.heartbeatAt.toISOString(),
        ownerHost: "test-host",
        ownerPid: input.ownerPid,
      },
      operationType: "spotify_playlist_export",
      ownerToken,
    });
    return ownerToken;
  }

  function loadLock() {
    return connection.db.query.operationLocks.findFirst({
      where: eq(operationLocks.lockKey, spotifyPlaylistWriterLockKey),
    });
  }
});
