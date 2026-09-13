import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import {
  cancelSpotifyBatch,
  claimNextSpotifyArtist,
  createSpotifyScanBatch,
  finishSpotifyArtistScan,
  recoverSpotifyBatch,
  requestSpotifyBatchPause,
  resumeSpotifyBatch,
} from "./spotify-batches";
import {
  clearInvalidSpotifyCooldown,
  createSpotifyRequestGate,
  deferSpotifyRequests,
  getSpotifyEndpointBudgetStatus,
  getSpotify429Telemetry,
  getSpotifyOperationalStatus,
  reconcileStaleSpotifyQueueDepth,
  SpotifyCooldownError,
  SpotifyEndpointBudgetError,
  SpotifyRequestDeadlineError,
} from "./spotify-request-gate";
import {
  artists,
  spotifyArtistScans,
  spotifyProviderState,
  spotifyRequestEvents,
  spotifyScanBatches,
  spotifySchedulerWork,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

let connection: ReturnType<typeof createDatabase>;
let db: RadarDatabase;

beforeAll(() => {
  connection = createDatabase(databaseUrl);
  db = connection.db;
});

beforeEach(async () => {
  await db.delete(spotifySchedulerWork);
  await db.delete(spotifyRequestEvents);
  await db.delete(spotifyProviderState);
  await db.delete(spotifyArtistScans);
  await db.delete(spotifyScanBatches);
});

afterAll(async () => {
  await connection.client.end();
});

describe("Spotify global request gate", () => {
  it("repairs an abandoned queue counter without touching a live waiter", async () => {
    const now = new Date("2026-08-19T04:00:00.000Z");
    await db.insert(spotifyProviderState).values({
      id: "global",
      nextRequestAt: new Date(now.getTime() - 60_000),
      queueDepth: 2,
      updatedAt: new Date(now.getTime() - 10 * 60_000),
    });

    await expect(reconcileStaleSpotifyQueueDepth(db, now)).resolves.toBe(true);
    await expect(getSpotifyOperationalStatus(db, now)).resolves.toMatchObject({ queueDepth: 0 });

    await db
      .update(spotifyProviderState)
      .set({ queueDepth: 1, updatedAt: new Date(now.getTime() - 30_000) })
      .where(eq(spotifyProviderState.id, "global"));
    await expect(reconcileStaleSpotifyQueueDepth(db, now)).resolves.toBe(false);
    await expect(getSpotifyOperationalStatus(db, now)).resolves.toMatchObject({ queueDepth: 1 });
  });

  it("preserves twenty Artist Albums calls for priority work while playlist work remains available", async () => {
    const now = new Date();
    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 60 }, (_, index) => ({
        endpointCategory: "artist_albums",
        id: randomUUID(),
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - 31 * 60_000 - index * 1_000),
        status: 200,
      })),
    );
    const status = await getSpotifyEndpointBudgetStatus(db, undefined, now);
    expect(status.artistAlbums).toMatchObject({
      allowance: 80,
      broadAllowance: 60,
      broadRemaining: 0,
      calls: 60,
      priorityReserve: 20,
      remaining: 20,
      reserveRemaining: 20,
      reserveReleased: false,
    });

    await expect(
      createSpotifyRequestGate(db, 10_000, undefined, undefined, {
        quotaLane: "broad",
      }).acquire({ endpointCategory: "artist_albums", method: "GET" }),
    ).rejects.toBeInstanceOf(SpotifyEndpointBudgetError);

    const playlistGate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
    });
    const permit = await playlistGate.acquire({ endpointCategory: "playlist_read", method: "GET" });
    await playlistGate.complete(permit, { status: 200 });
    expect((await getSpotifyEndpointBudgetStatus(db)).playlist.reads).toBe(1);
  });

  it("preserves rolling capacity for priority and playlist lanes", async () => {
    const now = new Date();
    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 5 }, (_, index) => ({
        endpointCategory: "album_detail",
        id: randomUUID(),
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - index * 1_000),
        status: 200,
      })),
    );
    const rollingRequestBudget = {
      playlistRequestReserve: 2,
      priorityRequestReserve: 3,
      rolling24HourLimit: 10,
      rolling30MinuteLimit: 10,
    };

    await expect(
      createSpotifyRequestGate(db, 10_000, undefined, undefined, {
        quotaLane: "broad",
        rollingRequestBudget,
      }).acquire({ endpointCategory: "album_detail", method: "GET" }),
    ).rejects.toMatchObject({
      endpointCategory: "rolling_requests",
      quotaLane: "broad",
    });

    const priorityGate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "priority",
      rollingRequestBudget,
    });
    const permit = await priorityGate.acquire({ endpointCategory: "album_detail", method: "GET" });
    await priorityGate.complete(permit, { status: 200 });
    expect(permit.eventId).toBeTruthy();
  });

  it("leaves the final rolling reserve to playlist work and enforces the global ceiling", async () => {
    const rollingRequestBudget = {
      playlistRequestReserve: 2,
      priorityRequestReserve: 3,
      rolling24HourLimit: 10,
      rolling30MinuteLimit: 20,
    };
    const seedEvents = async (count: number) => {
      const now = new Date();
      await db.insert(spotifyRequestEvents).values(
        Array.from({ length: count }, (_, index) => ({
          endpointCategory: "album_detail",
          id: randomUUID(),
          method: "GET",
          quotaLane: "priority" as const,
          queueWaitMs: 0,
          startedAt: new Date(now.getTime() - index * 1_000),
          status: 200,
        })),
      );
    };
    await seedEvents(8);

    await expect(
      createSpotifyRequestGate(db, 10_000, undefined, undefined, {
        quotaLane: "priority",
        rollingRequestBudget,
      }).acquire({ endpointCategory: "album_detail", method: "GET" }),
    ).rejects.toMatchObject({
      endpointCategory: "rolling_requests",
      quotaLane: "priority",
    });

    const playlistGate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
      rollingRequestBudget,
    });
    const first = await playlistGate.acquire({ endpointCategory: "playlist_read", method: "GET" });
    await playlistGate.complete(first, { status: 200 });
    await db
      .update(spotifyProviderState)
      .set({ nextRequestAt: null })
      .where(eq(spotifyProviderState.id, "global"));
    const second = await playlistGate.acquire({
      endpointCategory: "playlist_write",
      method: "POST",
    });
    await playlistGate.complete(second, { status: 201 });
    await db
      .update(spotifyProviderState)
      .set({ nextRequestAt: null })
      .where(eq(spotifyProviderState.id, "global"));

    await expect(
      playlistGate.acquire({ endpointCategory: "playlist_read", method: "GET" }),
    ).rejects.toMatchObject({
      endpointCategory: "rolling_requests",
      quotaLane: "playlist",
    });
  });

  it("enforces the global rolling 30-minute ceiling for playlist work", async () => {
    const now = new Date();
    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 3 }, (_, index) => ({
        endpointCategory: "playlist_read",
        id: randomUUID(),
        method: "GET",
        quotaLane: "playlist" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - index * 1_000),
        status: 200,
      })),
    );

    let rejection: unknown;
    try {
      await createSpotifyRequestGate(db, 10_000, undefined, undefined, {
        quotaLane: "playlist",
        rollingRequestBudget: {
          playlistRequestReserve: 2,
          priorityRequestReserve: 3,
          rolling24HourLimit: 10,
          rolling30MinuteLimit: 3,
        },
      }).acquire({ endpointCategory: "playlist_read", method: "GET" });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(SpotifyEndpointBudgetError);
    if (!(rejection instanceof SpotifyEndpointBudgetError)) return;
    expect(rejection.endpointCategory).toBe("rolling_requests");
    expect(rejection.nextCapacityAt).toBeInstanceOf(Date);
    expect(rejection.quotaLane).toBe("playlist");
  });

  it("lets opted-in playlist work wait for known near-term rolling capacity", async () => {
    let clock = new Date("2026-09-13T02:00:00.000Z");
    await db.insert(spotifyRequestEvents).values({
      endpointCategory: "playlist_read",
      id: randomUUID(),
      method: "GET",
      quotaLane: "playlist",
      queueWaitMs: 0,
      startedAt: new Date(clock.getTime() - 30 * 60_000 + 10_000),
      status: 200,
    });
    const waits: number[] = [];
    const gate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
      rollingCapacityWait: {
        maximumWaitMs: 15 * 60_000,
        now: () => clock,
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          clock = new Date(clock.getTime() + milliseconds);
          return Promise.resolve();
        },
      },
      rollingRequestBudget: {
        playlistRequestReserve: 0,
        priorityRequestReserve: 0,
        rolling24HourLimit: 100,
        rolling30MinuteLimit: 1,
      },
    });

    const permit = await gate.acquire({ endpointCategory: "playlist_read", method: "GET" });
    await gate.complete(permit, { status: 200 });

    expect(waits).toEqual([10_000]);
    expect(permit.queueWaitMs).toBe(10_000);
  });

  it("uses one shared deadline across sequential playlist capacity waits", async () => {
    const startedAt = new Date("2026-09-13T02:00:00.000Z");
    let clock = startedAt;
    await db.insert(spotifyRequestEvents).values([
      {
        endpointCategory: "playlist_read",
        id: randomUUID(),
        method: "GET",
        quotaLane: "playlist",
        queueWaitMs: 0,
        startedAt: new Date(startedAt.getTime() - 22 * 60_000),
        status: 200,
      },
      {
        endpointCategory: "playlist_read",
        id: randomUUID(),
        method: "GET",
        quotaLane: "playlist",
        queueWaitMs: 0,
        startedAt: new Date(startedAt.getTime() - 14 * 60_000),
        status: 200,
      },
    ]);
    const waits: number[] = [];
    const deadlineAt = new Date(startedAt.getTime() + 12 * 60_000);
    const gate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
      rollingCapacityWait: {
        deadlineAt,
        maximumWaitMs: 15 * 60_000,
        now: () => clock,
        sleep: (milliseconds) => {
          waits.push(milliseconds);
          clock = new Date(clock.getTime() + milliseconds);
          return Promise.resolve();
        },
      },
      rollingRequestBudget: {
        playlistRequestReserve: 0,
        priorityRequestReserve: 0,
        rolling24HourLimit: 100,
        rolling30MinuteLimit: 2,
      },
    });

    const first = await gate.acquire({ endpointCategory: "playlist_read", method: "GET" });
    await gate.complete(first, { status: 200 });

    let rejection: unknown;
    try {
      await gate.acquire({ endpointCategory: "playlist_read", method: "GET" });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(SpotifyRequestDeadlineError);
    if (!(rejection instanceof SpotifyRequestDeadlineError)) return;
    expect(rejection.deadlineAt).toEqual(deadlineAt);
    expect(rejection.nextCapacityAt).toEqual(new Date(startedAt.getTime() + 16 * 60_000));
    expect(waits).toEqual([8 * 60_000]);
  });

  it("cancels an opted-in playlist capacity wait", async () => {
    const clock = new Date("2026-09-13T02:00:00.000Z");
    await db.insert(spotifyRequestEvents).values({
      endpointCategory: "playlist_read",
      id: randomUUID(),
      method: "GET",
      quotaLane: "playlist",
      queueWaitMs: 0,
      startedAt: new Date(clock.getTime() - 30 * 60_000 + 10_000),
      status: 200,
    });
    const controller = new AbortController();
    const gate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
      rollingCapacityWait: {
        maximumWaitMs: 15 * 60_000,
        now: () => clock,
        sleep: (_milliseconds, signal) => {
          const cancellation = new Error("Synthetic playlist wait cancellation");
          controller.abort(cancellation);
          return Promise.reject(signal?.reason instanceof Error ? signal.reason : cancellation);
        },
      },
      rollingRequestBudget: {
        playlistRequestReserve: 0,
        priorityRequestReserve: 0,
        rolling24HourLimit: 100,
        rolling30MinuteLimit: 1,
      },
    });

    await expect(
      gate.acquire({
        endpointCategory: "playlist_read",
        method: "GET",
        signal: controller.signal,
      }),
    ).rejects.toThrow("Synthetic playlist wait cancellation");
  });

  it("yields when playlist rolling capacity is beyond the opted-in wait bound", async () => {
    const clock = new Date("2026-09-13T02:00:00.000Z");
    await db.insert(spotifyRequestEvents).values({
      endpointCategory: "playlist_read",
      id: randomUUID(),
      method: "GET",
      quotaLane: "playlist",
      queueWaitMs: 0,
      startedAt: new Date(clock.getTime() - 10 * 60_000),
      status: 200,
    });
    const sleep = vi.fn(() => Promise.resolve());
    const gate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
      quotaLane: "playlist",
      rollingCapacityWait: { maximumWaitMs: 15 * 60_000, now: () => clock, sleep },
      rollingRequestBudget: {
        playlistRequestReserve: 0,
        priorityRequestReserve: 0,
        rolling24HourLimit: 100,
        rolling30MinuteLimit: 1,
      },
    });

    await expect(
      gate.acquire({ endpointCategory: "playlist_read", method: "GET" }),
    ).rejects.toMatchObject({
      endpointCategory: "rolling_requests",
      nextCapacityAt: new Date(clock.getTime() + 20 * 60_000),
      quotaLane: "playlist",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not report broad capacity after priority work consumes the total allowance", async () => {
    const now = new Date();
    await db.insert(spotifyRequestEvents).values([
      ...Array.from({ length: 40 }, (_, index) => ({
        endpointCategory: "artist_albums",
        id: randomUUID(),
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - index * 1_000),
        status: 200,
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        endpointCategory: "artist_albums",
        id: randomUUID(),
        method: "GET",
        quotaLane: "priority" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - (index + 40) * 1_000),
        status: 200,
      })),
    ]);

    expect((await getSpotifyEndpointBudgetStatus(db, undefined, now)).artistAlbums).toMatchObject({
      broadRemaining: 0,
      calls: 80,
      priorityRemaining: 0,
      remaining: 0,
      reserveRemaining: 0,
    });
  });

  it("releases unused priority reserve only late in the trailing window and persists across restart", async () => {
    const now = new Date();
    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 60 }, (_, index) => ({
        endpointCategory: "artist_albums",
        id: randomUUID(),
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - 21 * 60 * 60_000 - index),
        status: 200,
      })),
    );
    const restarted = createDatabase(databaseUrl);
    try {
      expect(
        (await getSpotifyEndpointBudgetStatus(restarted.db, undefined, now)).artistAlbums,
      ).toMatchObject({ broadRemaining: 20, reserveReleased: true });
      const artistId = randomUUID();
      await restarted.db.insert(artists).values({
        id: artistId,
        name: "Priority reserve fixture",
        normalizedName: `priority-reserve-${artistId}`,
      });
      await restarted.db.insert(spotifySchedulerWork).values({
        artistId,
        dueAt: now,
        expectedSpotifyArtistId: `spotify-${artistId}`,
        priority: -100,
        source: "apple_priority",
        status: "queued",
        workKey: `priority:${randomUUID()}`,
        workType: "artist_reconciliation",
      });
      expect(
        (await getSpotifyEndpointBudgetStatus(restarted.db, undefined, now)).artistAlbums,
      ).toMatchObject({ broadRemaining: 0, reserveReleased: false });
    } finally {
      await restarted.client.end();
    }
  });

  it("attributes requests to one discovery reconciliation campaign", async () => {
    const campaignId = randomUUID();
    const gate = createSpotifyRequestGate(db, 10_000, undefined, campaignId);
    const permit = await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await gate.complete(permit, { status: 200 });

    const event = await db.query.spotifyRequestEvents.findFirst({
      where: eq(spotifyRequestEvents.id, permit.eventId),
    });
    expect(event).toMatchObject({ discoveryReconciliationCampaignId: campaignId, status: 200 });
  });

  it("binds deferred JavaScript dates as UTC and preserves them across connections", async () => {
    const now = new Date("2026-07-18T02:00:00.123-07:00");
    const deferredUntil = await deferSpotifyRequests(db, 5_000, now);
    expect(deferredUntil.toISOString()).toBe("2026-07-18T09:00:05.123Z");

    const restarted = createDatabase(databaseUrl);
    try {
      expect((await getSpotifyOperationalStatus(restarted.db)).nextRequestAt?.toISOString()).toBe(
        "2026-07-18T09:00:05.123Z",
      );
    } finally {
      await restarted.client.end();
    }
  });

  it("enforces a persisted ten-second deferral after a database reconnection", async () => {
    const deferredAt = Date.now();
    await deferSpotifyRequests(db, 10_000, new Date(deferredAt));
    const restarted = createDatabase(databaseUrl);
    try {
      const permit = await createSpotifyRequestGate(restarted.db, 10_000).acquire({
        endpointCategory: "artist_albums",
        method: "GET",
      });
      expect(permit.startedAt.getTime() - deferredAt).toBeGreaterThanOrEqual(9_900);
      await createSpotifyRequestGate(restarted.db, 10_000).complete(permit, { status: 200 });
    } finally {
      await restarted.client.end();
    }
  }, 15_000);

  it("handles missing state, concurrent deferrals, large delays, and invalid values", async () => {
    const now = new Date("2026-07-18T09:00:00.000Z");
    const [shorter, longer] = await Promise.all([
      deferSpotifyRequests(db, 86_400_000, now),
      deferSpotifyRequests(db, 365 * 86_400_000, now),
    ]);
    expect(["2026-07-19T09:00:00.000Z", "2027-07-18T09:00:00.000Z"]).toContain(
      shorter.toISOString(),
    );
    expect(longer.toISOString()).toBe("2027-07-18T09:00:00.000Z");
    expect((await getSpotifyOperationalStatus(db)).nextRequestAt?.toISOString()).toBe(
      "2027-07-18T09:00:00.000Z",
    );
    await expect(
      deferSpotifyRequests(db, "0; drop table scan_runs" as unknown as number, now),
    ).rejects.toThrow("Invalid Spotify request delay");
    await expect(deferSpotifyRequests(db, Number.MAX_SAFE_INTEGER, now)).rejects.toThrow(
      "supported timestamp range",
    );
  });

  it("does not shorten an existing deferral or weaken a later cooldown", async () => {
    const now = new Date();
    const deferredUntil = await deferSpotifyRequests(db, 120_000, now);
    const cooldownUntil = new Date(now.getTime() + 300_000);
    await db
      .update(spotifyProviderState)
      .set({
        cooldownObservedAt: now,
        cooldownStatus: 429,
        cooldownUntil,
      })
      .where(eq(spotifyProviderState.id, "global"));
    expect(await deferSpotifyRequests(db, 10_000, now)).toEqual(deferredUntil);
    const status = await getSpotifyOperationalStatus(db, now);
    expect(status.nextRequestAt).toEqual(deferredUntil);
    expect(status.cooldownUntil).toEqual(cooldownUntil);
    await expect(
      createSpotifyRequestGate(db, 10_000).acquire({
        endpointCategory: "artist_albums",
        method: "GET",
      }),
    ).rejects.toBeInstanceOf(SpotifyCooldownError);
  });

  it("persists a 429 cooldown and blocks a separate gate instance", async () => {
    const firstGate = createSpotifyRequestGate(db, 10_000);
    const permit = await firstGate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    const cooldownUntil = new Date(Date.now() + 60_000);
    await firstGate.complete(permit, {
      cooldownUntil,
      errorClassification: "rate_limited_integer_seconds",
      parsedRetryAfterSeconds: "60",
      rawRetryAfter: "60",
      responseClassification: "json_error",
      status: 429,
    });

    const status = await getSpotifyOperationalStatus(db);
    expect(status).toMatchObject({
      canManualClear: false,
      cooldownActive: true,
      cooldownEndpointCategory: "artist_albums",
      parsedRetryAfterSeconds: "60",
      rawRetryAfter: "60",
      requestCount: 1,
    });
    const secondGate = createSpotifyRequestGate(db, 10_000);
    await expect(
      secondGate.acquire({ endpointCategory: "current_user", method: "GET" }),
    ).rejects.toBeInstanceOf(SpotifyCooldownError);
    expect((await getSpotifyOperationalStatus(db)).requestCount).toBe(1);
    await expect(
      clearInvalidSpotifyCooldown(db, "The provider returned a valid integer wait."),
    ).resolves.toBe(false);
  });

  it("persists safe 429 classifications and aggregates legacy events without inference", async () => {
    const gate = createSpotifyRequestGate(db, 10_000);
    const permit = await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await gate.complete(permit, {
      cooldownUntil: new Date("2026-07-27T20:01:00.000Z"),
      errorClassification: "rate_limited_integer_seconds",
      parsedRetryAfterSeconds: "60",
      providerReasonToken: "QUOTA_EXCEEDED",
      rateLimitClassification: "quota_exceeded",
      rawRetryAfter: "60",
      responseClassification: "json_error",
      status: 429,
    });
    await db.insert(spotifyRequestEvents).values({
      endpointCategory: "album_tracks",
      method: "GET",
      queueWaitMs: 0,
      startedAt: new Date("2026-07-27T19:00:00.000Z"),
      status: 429,
    });

    const telemetry = await getSpotify429Telemetry(db, new Date("2026-07-27T20:10:00.000Z"));
    expect(telemetry.counts.allTime).toEqual({
      legacy_unknown: 1,
      quota_exceeded: 1,
      unknown_reason: 0,
      unspecified_429: 0,
    });
    expect(telemetry.counts.last30Minutes.quota_exceeded).toBe(1);
    expect(telemetry.historicalUnclassifiedCount).toBe(1);
    expect(telemetry.latest).toMatchObject({
      classification: "quota_exceeded",
      endpointCategory: "artist_albums",
      parsedRetryAfterSeconds: "60",
      providerReasonToken: "QUOTA_EXCEEDED",
      rawRetryAfter: "60",
    });

    const stored = await db.query.spotifyRequestEvents.findFirst({
      where: (table, { eq }) => eq(table.id, permit.eventId),
    });
    expect(stored).toMatchObject({
      providerReasonToken: "QUOTA_EXCEEDED",
      rateLimitClassification: "quota_exceeded",
    });
    expect(JSON.stringify(stored)).not.toContain("response body");
  });

  it("rejects arbitrary provider text at the persistence boundary", async () => {
    const gate = createSpotifyRequestGate(db, 10_000);
    const permit = await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await gate.complete(permit, {
      providerReasonToken: "unsafe provider message: personal data",
      rateLimitClassification: "unknown_reason",
      status: 429,
    });
    const stored = await db.query.spotifyRequestEvents.findFirst({
      where: (table, { eq }) => eq(table.id, permit.eventId),
    });
    expect(stored?.providerReasonToken).toBeNull();
  });

  it("allows confirmed correction only for an invalid local parse", async () => {
    const gate = createSpotifyRequestGate(db, 10_000);
    const permit = await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await gate.complete(permit, {
      cooldownUntil: new Date(Date.now() + 60_000),
      errorClassification: "rate_limited_malformed",
      rawRetryAfter: "invalid",
      status: 429,
    });

    expect((await getSpotifyOperationalStatus(db)).canManualClear).toBe(true);
    await expect(
      clearInvalidSpotifyCooldown(db, "Verified malformed header parsing in local telemetry."),
    ).resolves.toBe(true);
    expect((await getSpotifyOperationalStatus(db)).cooldownActive).toBe(false);
  });

  it("serializes requests and records queue waits", async () => {
    const gate = createSpotifyRequestGate(db, 10_000);
    const first = await gate.acquire({ endpointCategory: "artist", method: "GET" });
    await gate.complete(first, { status: 200 });
    const second = await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await gate.complete(second, { status: 200 });

    const events = await db.query.spotifyRequestEvents.findMany({
      orderBy: (table, { asc }) => [asc(table.startedAt)],
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.startedAt.getTime() - events[0]!.startedAt.getTime()).toBeGreaterThanOrEqual(
      9_900,
    );
    expect(events[1]!.queueWaitMs).toBeGreaterThanOrEqual(9_900);
  }, 15_000);

  it("serializes concurrent callers across gate instances", async () => {
    const firstGate = createSpotifyRequestGate(db, 10_000);
    const secondGate = createSpotifyRequestGate(db, 10_000);
    const first = await firstGate.acquire({ endpointCategory: "artist", method: "GET" });
    const secondPromise = secondGate.acquire({
      endpointCategory: "artist_albums",
      method: "GET",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await firstGate.complete(first, { status: 200 });
    const second = await secondPromise;
    await secondGate.complete(second, { status: 200 });
    expect(second.startedAt.getTime() - first.startedAt.getTime()).toBeGreaterThanOrEqual(9_900);
    expect(second.startedAt.getTime() - first.startedAt.getTime()).toBeLessThan(15_000);
  }, 20_000);
});

describe("Spotify resumable batches", () => {
  it("recovers running work, pauses safely, resumes, and preserves completed rows on cancel", async () => {
    const [firstArtist, secondArtist] = await db
      .insert(artists)
      .values([
        { name: `Batch ${randomUUID()}`, normalizedName: randomUUID(), sortName: null },
        { name: `Batch ${randomUUID()}`, normalizedName: randomUUID(), sortName: null },
      ])
      .returning({ id: artists.id });
    if (!firstArtist || !secondArtist) throw new Error("Artist fixtures were not created");
    const batchId = await createSpotifyScanBatch(db, {
      artists: [{ artistId: firstArtist.id }, { artistId: secondArtist.id }],
      confirmationRequired: false,
      estimatedRequests: 22,
      mode: "initial",
      pageLimit: 2,
    });

    const first = await claimNextSpotifyArtist(db, batchId);
    expect(first?.artistId).toBe(firstArtist.id);
    await recoverSpotifyBatch(db, batchId);
    const recovered = await claimNextSpotifyArtist(db, batchId);
    expect(recovered?.artistId).toBe(firstArtist.id);
    await finishSpotifyArtistScan(db, {
      artistScanId: recovered!.id,
      backfillReleaseCount: 4,
      candidateCount: 1,
      pagesScanned: 2,
      releaseCount: 7,
      requestCount: 3,
      status: "partial",
    });
    expect(await requestSpotifyBatchPause(db, batchId)).toBe(true);
    expect(await claimNextSpotifyArtist(db, batchId)).toBeNull();
    expect(await resumeSpotifyBatch(db, batchId)).toBe(true);
    const second = await claimNextSpotifyArtist(db, batchId);
    expect(second?.artistId).toBe(secondArtist.id);
    await recoverSpotifyBatch(db, batchId);
    expect(await cancelSpotifyBatch(db, batchId)).toBe(true);

    const rows = await db.query.spotifyArtistScans.findMany({
      where: (table, { eq }) => eq(table.batchId, batchId),
      orderBy: (table, { asc }) => [asc(table.position)],
    });
    expect(rows.map((row) => row.status)).toEqual(["partial", "cancelled"]);
    expect(rows[0]).toMatchObject({ backfillReleaseCount: 4, releaseCount: 7 });
    expect(rows[1]).toMatchObject({ backfillReleaseCount: null, releaseCount: null });
  });
});
