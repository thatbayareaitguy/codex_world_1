import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppleMusicAlbum, AppleMusicSong } from "@radar/providers";
import { createDatabase } from "./client";
import {
  createAppleMusicRequestPersistence,
  getAppleMusicOperationalStatus,
  saveAppleMusicArtistMapping,
  saveAppleMusicCatalog,
  saveAppleMusicComparisons,
} from "./apple-music";
import {
  appleMusicAlbums,
  appleMusicArtistMappings,
  appleMusicComparisonRuns,
  appleMusicComparisons,
  appleMusicMappingCandidates,
  appleMusicProviderState,
  appleMusicRequestEvents,
  appleMusicResponseCache,
  appleMusicSongs,
  feedItems,
  itunesPilotSnapshots,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:55436/radar_apple_test";

describe.sequential("Apple Music isolated persistence and global request gate", () => {
  const connection = createDatabase(databaseUrl);
  let snapshotId = "";

  beforeAll(async () => {
    const [snapshot] = await connection.db
      .insert(itunesPilotSnapshots)
      .values({
        artistCount: 50,
        mainRepositoryCommit: "a".repeat(40),
        mainSchemaVersion: 17,
        releaseCount: 1,
        snapshotHash: randomUUID().replaceAll("-", "").padEnd(64, "b"),
        snapshotTimestamp: new Date("2026-07-28T12:00:00Z"),
        windowEnd: "2026-07-28",
        windowStart: "2026-05-29",
      })
      .returning({ id: itunesPilotSnapshots.id });
    snapshotId = snapshot!.id;
  });

  beforeEach(async () => {
    await connection.db.delete(appleMusicRequestEvents);
    await connection.db.delete(appleMusicResponseCache);
    await connection.db.delete(appleMusicProviderState);
    await connection.db
      .delete(appleMusicComparisonRuns)
      .where(eq(appleMusicComparisonRuns.snapshotId, snapshotId));
  });

  afterAll(async () => {
    if (snapshotId) {
      await connection.db
        .delete(appleMusicComparisonRuns)
        .where(eq(appleMusicComparisonRuns.snapshotId, snapshotId));
    }
    if (snapshotId) {
      await connection.db
        .delete(itunesPilotSnapshots)
        .where(eq(itunesPilotSnapshots.id, snapshotId));
    }
    await connection.client.end();
  });

  it("enforces concurrency one and at least 1100 milliseconds between starts", async () => {
    const runId = await createRunningRun(2);
    const persistence = createAppleMusicRequestPersistence(connection.db);
    const first = await persistence.acquire({
      endpointCategory: "artist",
      identity: "/v1/catalog/us/artists/1",
      maxRequests: 2,
      minIntervalMs: 1_100,
      runId,
    });
    let secondResolved = false;
    const secondPromise = persistence
      .acquire({
        endpointCategory: "artist",
        identity: "/v1/catalog/us/artists/2",
        maxRequests: 2,
        minIntervalMs: 1_100,
        runId,
      })
      .then((permit) => {
        secondResolved = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResolved).toBe(false);
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: first.eventId,
      leaseToken: first.leaseToken,
      status: 200,
    });
    const second = await secondPromise;
    expect(second.startedAt.getTime() - first.startedAt.getTime()).toBeGreaterThanOrEqual(1_050);
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: second.eventId,
      leaseToken: second.leaseToken,
      status: 200,
    });
  }, 5_000);

  it("enforces request budgets and persists an immediate 429 cooldown", async () => {
    const runId = await createRunningRun(2);
    const persistence = createAppleMusicRequestPersistence(connection.db);
    const permit = await persistence.acquire({
      endpointCategory: "artist_search",
      identity: "/v1/catalog/us/search?term=one&types=artists",
      maxRequests: 2,
      minIntervalMs: 1_100,
      runId,
    });
    const completedAt = new Date();
    await persistence.complete({
      bodyBytes: 20,
      completedAt,
      cooldownUntil: new Date(completedAt.getTime() + 60_000),
      errorClassification: "rate_limited",
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      retryAfterSeconds: 60,
      status: 429,
    });
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: true,
      cooldownIndefinite: false,
      leaseActive: false,
    });
    await expect(
      persistence.acquire({
        endpointCategory: "artist",
        identity: "/v1/catalog/us/artists/2",
        maxRequests: 2,
        minIntervalMs: 1_100,
        runId,
      }),
    ).rejects.toMatchObject({ classification: "provider_cooldown" });
  });

  it("stores normalized cache and safe telemetry without authorization material", async () => {
    const runId = await createRunningRun(1);
    const persistence = createAppleMusicRequestPersistence(connection.db);
    const identity = "/v1/catalog/us/artists/42";
    const permit = await persistence.acquire({
      endpointCategory: "artist",
      identity,
      maxRequests: 1,
      minIntervalMs: 1_100,
      runId,
    });
    const normalized = {
      data: [
        {
          attributes: { genreNames: [], name: "Synthetic" },
          id: "42",
          type: "artists",
        },
      ],
    };
    await persistence.complete({
      bodyBytes: 100,
      cacheValue: normalized,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    expect(await persistence.loadCache(identity)).toEqual(normalized);
    await persistence.recordCacheHit({
      endpointCategory: "artist",
      identity,
      runId,
    });
    const events = await connection.db.select().from(appleMusicRequestEvents);
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.cacheHit)).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Bearer");
    expect(JSON.stringify(await connection.db.select().from(appleMusicResponseCache))).not.toMatch(
      /artwork|preview|token/i,
    );
  });

  it("persists mapping evidence, normalized catalog rows, and comparisons idempotently", async () => {
    const runId = await createRunningRun(5);
    const canonicalArtistId = randomUUID();
    const decision = {
      candidates: [
        {
          artistId: "42",
          evidenceUrl: "https://music.apple.com/us/artist/synthetic/42",
          name: "Synthetic",
        },
      ],
      confidence: 1,
      evidence: [
        {
          artistId: "42",
          conflictingReleaseTitles: [],
          exactReleaseTitles: ["Album"],
          exactTrackTitles: ["Track"],
          reasons: ["Synthetic fixture evidence."],
          score: 4,
        },
      ],
      reason: "Synthetic exact match.",
      selected: { artistId: "42", name: "Synthetic" },
      status: "search_confirmed" as const,
    };
    await saveAppleMusicArtistMapping(connection.db, {
      canonicalArtistId,
      decision,
      inheritedItunesArtistId: "42",
      runId,
    });
    await saveAppleMusicArtistMapping(connection.db, {
      canonicalArtistId,
      decision,
      inheritedItunesArtistId: "42",
      runId,
    });

    const albums: AppleMusicAlbum[] = [
      {
        albumId: "album-1",
        artistIds: ["42"],
        artistName: "Synthetic",
        evidenceUrl: "https://music.apple.com/us/album/album-1",
        genreNames: [],
        paginationPath: "/v1/catalog/us/artists/42/view/full-albums",
        pageNumber: 1,
        releaseDate: "2026-07-01",
        sourceStorefront: "us",
        sourceView: "full-albums",
        title: "Album",
        trackCount: 1,
        upc: "123456789012",
      },
    ];
    const songs: AppleMusicSong[] = [
      {
        albumId: "album-1",
        artistIds: ["42"],
        artistName: "Synthetic",
        discNumber: 1,
        durationMs: 180_000,
        evidenceUrl: "https://music.apple.com/us/song/1",
        isrc: "USAAA2600001",
        paginationPath: "/v1/catalog/us/albums/album-1/tracks",
        pageNumber: 1,
        releaseDate: "2026-07-01",
        songId: "song-1",
        sourceStorefront: "us",
        title: "Track",
        trackNumber: 1,
      },
    ];
    await saveAppleMusicCatalog(connection.db, {
      albums,
      canonicalArtistId,
      runId,
      songs,
    });
    await saveAppleMusicCatalog(connection.db, {
      albums,
      canonicalArtistId,
      runId,
      songs,
    });
    await saveAppleMusicComparisons(connection.db, {
      canonicalArtistId,
      comparisons: [
        {
          apple: {
            artistId: "42",
            artistName: "Synthetic",
            collectionId: "album-1",
            collectionName: "Album",
            releaseDate: "2026-07-01T00:00:00Z",
            source: "album_lookup",
          },
          classification: "exact_match",
          reasons: ["Synthetic fixture match."],
          spotifyReleaseId: "spotify-1",
        },
      ],
      runId,
    });
    expect(await connection.db.select().from(appleMusicArtistMappings)).toHaveLength(1);
    expect(await connection.db.select().from(appleMusicMappingCandidates)).toHaveLength(1);
    expect(await connection.db.select().from(appleMusicAlbums)).toHaveLength(1);
    expect(await connection.db.select().from(appleMusicSongs)).toHaveLength(1);
    expect(await connection.db.select().from(appleMusicComparisons)).toHaveLength(1);
  });

  it("does not mutate production feed tables", async () => {
    const before = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(feedItems);
    const runId = await createRunningRun(1);
    const persistence = createAppleMusicRequestPersistence(connection.db);
    const permit = await persistence.acquire({
      endpointCategory: "artist",
      identity: "/v1/catalog/us/artists/isolation",
      maxRequests: 1,
      minIntervalMs: 1_100,
      runId,
    });
    await persistence.complete({
      bodyBytes: 0,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    const after = await connection.db.select({ count: sql<number>`count(*)::int` }).from(feedItems);
    expect(after).toEqual(before);
  });

  async function createRunningRun(requestBudget: number): Promise<string> {
    const [run] = await connection.db
      .insert(appleMusicComparisonRuns)
      .values({
        deadlineAt: new Date(Date.now() + 60_000),
        implementationCommit: "c".repeat(40),
        maximumRuntimeMs: 60_000,
        requestBudget,
        snapshotId,
        startedAt: new Date(),
        status: "running",
      })
      .returning({ id: appleMusicComparisonRuns.id });
    return run!.id;
  }
});
