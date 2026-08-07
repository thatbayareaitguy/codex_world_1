import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  getSpotify429Telemetry,
  getSpotifyOperationalStatus,
  SpotifyCooldownError,
} from "./spotify-request-gate";
import {
  artists,
  spotifyArtistScans,
  spotifyProviderState,
  spotifyRequestEvents,
  spotifyScanBatches,
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
  await db.delete(spotifyRequestEvents);
  await db.delete(spotifyProviderState);
  await db.delete(spotifyArtistScans);
  await db.delete(spotifyScanBatches);
});

afterAll(async () => {
  await connection.client.end();
});

describe("Spotify global request gate", () => {
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
    expect(shorter.toISOString()).toBe("2026-07-19T09:00:00.000Z");
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
    await firstGate.complete(first, { status: 200 });
    const second = await secondPromise;
    await secondGate.complete(second, { status: 200 });
    expect(second.startedAt.getTime() - first.startedAt.getTime()).toBeGreaterThanOrEqual(9_900);
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
