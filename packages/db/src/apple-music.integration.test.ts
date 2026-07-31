import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleMusicClient, type AppleMusicAlbum, type AppleMusicSong } from "@radar/providers";
import { createDatabase } from "./client";
import {
  claimAppleMusicPilotLease,
  createAppleMusicComparisonRun,
  createAppleMusicRequestPersistence,
  finishAppleMusicComparisonRun,
  getConfirmedAppleMusicArtistMapping,
  getLastSuccessfulAppleMusicRecentScan,
  getAppleMusicOperationalStatus,
  releaseAppleMusicPilotLease,
  saveAppleMusicArtistMapping,
  saveAppleMusicCatalog,
  saveAppleMusicComparisons,
  saveAppleMusicRecentCandidates,
} from "./apple-music";
import {
  appleMusicAlbums,
  appleMusicArtistMappings,
  appleMusicComparisonRuns,
  appleMusicComparisons,
  appleMusicMappingCandidates,
  appleMusicProviderState,
  appleMusicRecentCandidates,
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

  it("holds one run-scoped lease across paced requests and releases it explicitly", async () => {
    const run = await createAppleMusicComparisonRun(connection.db, {
      implementationCommit: "d".repeat(40),
      maximumRuntimeMs: 60_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 2,
      snapshotId,
    });
    const leaseToken = await claimAppleMusicPilotLease(connection.db, run.id);
    const persistence = createAppleMusicRequestPersistence(connection.db, {
      runLeaseToken: leaseToken,
    });
    const permit = await persistence.acquire({
      endpointCategory: "artist",
      identity: "/v1/catalog/us/artists/scoped",
      maxRequests: 2,
      minIntervalMs: 1_100,
      runId: run.id,
    });
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      leaseActive: true,
      requestCount: 1,
    });
    await finishAppleMusicComparisonRun(connection.db, run.id, {
      metrics: { requestCount: 1 },
      status: "canary_completed",
      stopReason: "synthetic_canary_complete",
    });
    await releaseAppleMusicPilotLease(connection.db, leaseToken);
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      leaseActive: false,
    });
    expect(
      await connection.db.query.appleMusicComparisonRuns.findFirst({
        where: eq(appleMusicComparisonRuns.id, run.id),
      }),
    ).toMatchObject({
      requestCount: 1,
      status: "canary_completed",
      stopReason: "synthetic_canary_complete",
    });
  });

  it("preserves an indefinite 429 cooldown while releasing the run-scoped lease", async () => {
    const run = await createAppleMusicComparisonRun(connection.db, {
      implementationCommit: "e".repeat(40),
      maximumRuntimeMs: 60_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 1,
      snapshotId,
    });
    const leaseToken = await claimAppleMusicPilotLease(connection.db, run.id);
    const persistence = createAppleMusicRequestPersistence(connection.db, {
      runLeaseToken: leaseToken,
    });
    const permit = await persistence.acquire({
      endpointCategory: "artist",
      identity: "/v1/catalog/us/artists/rate-limited",
      maxRequests: 1,
      minIntervalMs: 1_100,
      runId: run.id,
    });
    await persistence.complete({
      bodyBytes: 0,
      completedAt: new Date(),
      errorClassification: "rate_limited",
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 429,
    });
    await releaseAppleMusicPilotLease(connection.db, leaseToken);
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: true,
      cooldownIndefinite: true,
      leaseActive: false,
    });
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

  it("caches artist identity only after inert embedded pagination is discarded", async () => {
    const runId = await createRunningRun(1);
    const persistence = createAppleMusicRequestPersistence(connection.db);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              attributes: {
                genreNames: [],
                name: "Synthetic",
                url: "https://music.apple.com/us/artist/synthetic",
              },
              href: "https://outside.invalid/non-followed-resource",
              id: "synthetic",
              relationships: {
                albums: {
                  data: [],
                  href: "https://outside.invalid/embedded-href",
                  next: "/v1/catalog/us/artists/synthetic/albums?offset=25",
                },
                unsupported: {
                  data: [],
                  next: "/v1/me/library",
                },
              },
              type: "artists",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new AppleMusicClient({
      enabled: true,
      fetchImpl,
      maxRetries: 0,
      persistence,
      runId,
      tokenProvider: { getToken: () => "synthetic-token" },
    });

    await expect(client.getArtist("synthetic")).resolves.toMatchObject({
      artistId: "synthetic",
      name: "Synthetic",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cache = await connection.db.select().from(appleMusicResponseCache);
    expect(cache).toHaveLength(1);
    const serialized = JSON.stringify(cache);
    expect(serialized).not.toMatch(
      /music\.apple\.com|outside\.invalid|embedded|\/v1\/me|"href"|"next"|"url"/,
    );
    const events = await connection.db.select().from(appleMusicRequestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ errorClassification: null, status: 200 });
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: false,
      leaseActive: false,
      requestCount: 1,
    });
  });

  it("keeps unsafe pagination out of cache and releases leases with sanitized telemetry", async () => {
    const run = await createAppleMusicComparisonRun(connection.db, {
      implementationCommit: "f".repeat(40),
      maximumRuntimeMs: 60_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 2,
      snapshotId,
    });
    const runLeaseToken = await claimAppleMusicPilotLease(connection.db, run.id);
    const persistence = createAppleMusicRequestPersistence(connection.db, {
      runLeaseToken,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [],
          next: "https://outside.invalid/v1/catalog/us/artists/private-id/view/singles?token=secret",
        }),
        { status: 200 },
      ),
    );
    const client = new AppleMusicClient({
      enabled: true,
      fetchImpl,
      maxRetries: 0,
      persistence,
      runId: run.id,
      tokenProvider: { getToken: () => "synthetic-token" },
    });

    try {
      await expect(client.getArtistView("synthetic", "singles")).rejects.toMatchObject({
        classification: "unsafe_url",
      });
    } finally {
      await finishAppleMusicComparisonRun(connection.db, run.id, {
        metrics: { requestCount: 1 },
        status: "failed",
        stopReason: "unsafe_url",
      });
      await releaseAppleMusicPilotLease(connection.db, runLeaseToken);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await connection.db.select().from(appleMusicResponseCache)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicArtistMappings)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicAlbums)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicSongs)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicComparisons)).toHaveLength(0);
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: false,
      leaseActive: false,
      requestCount: 1,
    });
    expect(
      await connection.db.query.appleMusicComparisonRuns.findFirst({
        where: eq(appleMusicComparisonRuns.id, run.id),
      }),
    ).toMatchObject({ status: "failed", stopReason: "unsafe_url" });
    const events = await connection.db.select().from(appleMusicRequestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      errorClassification: "unsafe_url:response.next:artist_view:artist_view:cross_host",
      status: 200,
    });
    const telemetry = JSON.stringify(events);
    for (const prohibited of [
      "outside.invalid",
      "private-id",
      "token=secret",
      "synthetic-token",
      "authorization",
    ]) {
      expect(telemetry).not.toContain(prohibited);
    }
  });

  it("retains safe HTTP 400 diagnostics with zero cache or result rows and a released lease", async () => {
    const run = await createAppleMusicComparisonRun(connection.db, {
      implementationCommit: "f".repeat(40),
      maximumRuntimeMs: 60_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 1,
      snapshotId,
    });
    const runLeaseToken = await claimAppleMusicPilotLease(connection.db, run.id);
    const persistence = createAppleMusicRequestPersistence(connection.db, {
      runLeaseToken,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            {
              code: "PARAMETER_ERROR.INVALID",
              detail: "Unsafe raw detail with artist-secret and a complete URL",
              id: "error-occurrence-secret",
              source: { parameter: "limit", pointer: "/data/artist-secret" },
              status: "400",
              title: "A parameter has an invalid value",
            },
          ],
        }),
        { status: 400 },
      ),
    );
    const client = new AppleMusicClient({
      enabled: true,
      fetchImpl,
      maxRetries: 0,
      persistence,
      runId: run.id,
      tokenProvider: { getToken: () => "synthetic-token" },
    });

    try {
      await expect(
        client.getArtistViewFirstPage("artist-secret", "latest-release"),
      ).rejects.toMatchObject({
        appleError: {
          code: "PARAMETER_ERROR.INVALID",
          detailPresent: true,
          sourceParameter: "limit",
          sourcePointer: "json_pointer",
          titleCategory: "invalid_request",
        },
        classification: "bad_request",
        status: 400,
      });
    } finally {
      await finishAppleMusicComparisonRun(connection.db, run.id, {
        metrics: { requestCount: 1 },
        status: "controlled_partial",
        stopReason: "view_probe_http_400",
      });
      await releaseAppleMusicPilotLease(connection.db, runLeaseToken);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await connection.db.select().from(appleMusicResponseCache)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicArtistMappings)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicAlbums)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicSongs)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicComparisons)).toHaveLength(0);
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: false,
      leaseActive: false,
      requestCount: 1,
    });
    const events = await connection.db.select().from(appleMusicRequestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe(400);
    expect(events[0]?.requestIdentity).toMatch(/^v2:artist_view:initial:[a-f0-9]{64}$/);
    const retained = JSON.stringify(events);
    expect(retained).toContain("PARAMETER_ERROR.INVALID");
    for (const prohibited of [
      "artist-secret",
      "error-occurrence-secret",
      "Unsafe raw detail",
      "synthetic-token",
      "authorization",
      "/v1/catalog/",
    ]) {
      expect(retained).not.toContain(prohibited);
    }
  });

  it("persists one sanitized artist-view HTTP 404 event with no successful cache row", async () => {
    const run = await createAppleMusicComparisonRun(connection.db, {
      implementationCommit: "4".repeat(40),
      maximumRuntimeMs: 60_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 1,
      snapshotId,
    });
    const runLeaseToken = await claimAppleMusicPilotLease(connection.db, run.id);
    const persistence = createAppleMusicRequestPersistence(connection.db, {
      runLeaseToken,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            {
              code: "40403",
              detail: "Unsafe unavailable detail with artist-secret",
              id: "error-occurrence-secret",
              status: "404",
              title: "Not Found",
            },
          ],
        }),
        { status: 404 },
      ),
    );
    const client = new AppleMusicClient({
      enabled: true,
      fetchImpl,
      maxRetries: 3,
      persistence,
      runId: run.id,
      tokenProvider: { getToken: () => "synthetic-token" },
    });

    try {
      await expect(client.getArtistView("artist-secret", "live-albums")).rejects.toMatchObject({
        appleError: {
          code: "40403",
          endpointCategory: "artist_view",
          status: 404,
          titleCategory: "not_found",
          view: "live-albums",
        },
        classification: "not_found",
        status: 404,
      });
    } finally {
      await finishAppleMusicComparisonRun(connection.db, run.id, {
        metrics: {
          viewResults: [
            {
              paginationRequests: 0,
              requestCount: 1,
              resourceCount: 0,
              status: "unavailable_404",
              terminalPagination: false,
              view: "live-albums",
            },
          ],
        },
        status: "controlled_partial",
        stopReason: "synthetic_unavailable_view",
      });
      await releaseAppleMusicPilotLease(connection.db, runLeaseToken);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await connection.db.select().from(appleMusicResponseCache)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicAlbums)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicSongs)).toHaveLength(0);
    expect(await connection.db.select().from(appleMusicComparisons)).toHaveLength(0);
    expect(await getAppleMusicOperationalStatus(connection.db)).toMatchObject({
      cooldownActive: false,
      leaseActive: false,
      requestCount: 1,
    });
    const events = await connection.db.select().from(appleMusicRequestEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 404 });
    expect(events[0]?.requestIdentity).toMatch(/^v2:artist_view:initial:[a-f0-9]{64}$/);
    const retained = JSON.stringify(events);
    expect(retained).toContain("not_found|s=404|c=40403");
    for (const prohibited of [
      "artist-secret",
      "error-occurrence-secret",
      "Unsafe unavailable detail",
      "synthetic-token",
      "authorization",
      "/v1/catalog/",
    ]) {
      expect(retained).not.toContain(prohibited);
    }
  });

  it("reads the latest confirmed mapping for an imported snapshot without exposing it", async () => {
    const runId = await createRunningRun(1);
    const canonicalArtistId = randomUUID();
    await saveAppleMusicArtistMapping(connection.db, {
      canonicalArtistId,
      decision: {
        candidates: [],
        confidence: 1,
        evidence: [],
        reason: "Synthetic exact identity.",
        selected: { artistId: "synthetic-private", name: "Synthetic" },
        status: "search_confirmed",
      },
      runId,
    });
    await expect(
      getConfirmedAppleMusicArtistMapping(connection.db, {
        canonicalArtistId,
        snapshotId,
      }),
    ).resolves.toEqual({ appleArtistId: "synthetic-private" });
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

  it("persists idempotent recent candidates and advances only completed recent runs", async () => {
    const canonicalArtistId = randomUUID();
    const runId = await createRunningRun(10);
    const candidate = {
      albumId: "synthetic-album",
      albumTitle: "Signal (Synthetic Remix)",
      appleArtistName: "Original Artist",
      classification: "remix_by_watched_artist",
      comparisonTitle: "Signal (Synthetic Remix)",
      comparisonStatus: "exact_match",
      eligible: true,
      evidenceStrength: "explicit",
      granularity: "album" as const,
      namedRemixer: "Synthetic",
      releaseDate: "2026-07-10",
      sources: ["catalog-search-album"],
    };
    await saveAppleMusicRecentCandidates(connection.db, {
      candidates: [candidate],
      canonicalArtistId,
      runId,
    });
    await saveAppleMusicRecentCandidates(connection.db, {
      candidates: [{ ...candidate, sources: ["appears-on-albums", "catalog-search-album"] }],
      canonicalArtistId,
      runId,
    });
    expect(await connection.db.select().from(appleMusicRecentCandidates)).toMatchObject([
      {
        candidateStatus: "eligible",
        classification: "remix_by_watched_artist",
        sourceArms: ["appears-on-albums", "catalog-search-album"],
      },
    ]);
    expect(await getLastSuccessfulAppleMusicRecentScan(connection.db)).toBeUndefined();
    await finishAppleMusicComparisonRun(connection.db, runId, {
      metrics: { mode: "recent_mvp" },
      status: "completed",
      stopReason: "recent_sample_completed",
    });
    expect(await getLastSuccessfulAppleMusicRecentScan(connection.db)).toBeInstanceOf(Date);
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
