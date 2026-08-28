import type { TrackCandidate } from "@radar/core";
import {
  createDatabase,
  createSpotifyScanBatch,
  ensureLocalOwner,
  feedItems,
  getReleaseReviewQueueStatus,
  loadSpotifyReleaseTrackResume,
  manualMatchDecisions,
  markSpotifyReleaseTrackInterrupted,
  reconcileSpotifyBatchMappings,
  recordSpotifyReleaseTrackPage,
  releaseCandidates,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  releases,
  resolveFeedReview,
  resolveFeedReviewGroup,
  sourceEvidence,
  spotifyArtistScans,
  spotifyReleaseTrackCompletenessSummary,
  spotifyReleaseTrackItems,
  spotifyReleaseTrackPages,
  spotifyReleaseTrackRetrievals,
  spotifyScanBatches,
  startSpotifyReleaseTrackRetrieval,
  trackExternalIds,
  tracks,
} from "@radar/db";
import { asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { persistCandidates } from "./scan";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(databaseUrl);

afterAll(async () => {
  await connection.client.end();
});

describe.sequential("release appearance and Spotify album completeness", () => {
  it("keeps one recording while representing its single and album appearances", async () => {
    const suffix = randomUUID();
    const isrc = `USINT${suffix.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    const observedAppearances = [
      candidate({
        externalReleaseId: `single-${suffix}`,
        externalTrackId: `single-track-${suffix}`,
        isrc,
        releaseTitle: `Integrity Single ${suffix}`,
        releaseType: "single",
      }),
      candidate({
        externalReleaseId: `album-${suffix}`,
        externalTrackId: `album-track-${suffix}`,
        isrc,
        releaseTitle: `Integrity Album ${suffix}`,
        releaseType: "album",
        trackNumber: 4,
      }),
      candidate({
        discNumber: 2,
        externalReleaseId: `deluxe-${suffix}`,
        externalTrackId: `deluxe-track-${suffix}`,
        isrc,
        releaseTitle: `Integrity Album ${suffix} (Deluxe Edition)`,
        releaseType: "album",
        trackNumber: 2,
      }),
      candidate({
        externalReleaseId: `compilation-${suffix}`,
        externalTrackId: `compilation-track-${suffix}`,
        isrc,
        releaseTitle: `Integrity Compilation ${suffix}`,
        releaseType: "compilation",
        trackNumber: 8,
      }),
      candidate({
        externalReleaseId: `remix-${suffix}`,
        externalTrackId: `remix-track-${suffix}`,
        isrc,
        releaseTitle: `Integrity Remix ${suffix}`,
        releaseType: "remix",
        trackNumber: 1,
      }),
    ];

    await persistCandidates(connection.db, observedAppearances, {
      dryRun: false,
      full: false,
      provider: "spotify",
    });

    const candidates = await connection.db
      .select()
      .from(releaseCandidates)
      .where(
        inArray(releaseCandidates.providerReleaseId, [
          ...observedAppearances.map((candidate) => candidate.externalReleaseId),
        ]),
      );
    expect(new Set(candidates.map((row) => row.matchedTrackId)).size).toBe(1);
    const sources = await connection.db
      .select()
      .from(releaseTrackAppearanceSources)
      .where(
        inArray(
          releaseTrackAppearanceSources.candidateId,
          candidates.map((row) => row.id),
        ),
      );
    expect(sources).toHaveLength(5);
    expect(new Set(sources.map((row) => row.appearanceId)).size).toBe(5);
    const appearances = await connection.db
      .select()
      .from(releaseTrackAppearances)
      .where(
        inArray(
          releaseTrackAppearances.id,
          sources.map((row) => row.appearanceId),
        ),
      );
    expect(new Set(appearances.map((row) => row.releaseId)).size).toBe(5);
    expect(appearances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ discNumber: 2, trackNumber: 2 }),
        expect.objectContaining({ discNumber: 1, trackNumber: 8 }),
      ]),
    );
    const feeds = await connection.db
      .select()
      .from(feedItems)
      .where(
        inArray(
          feedItems.candidateId,
          candidates.map((row) => row.id),
        ),
      );
    expect(feeds).toHaveLength(5);
    expect(feeds.every((row) => row.appearanceId !== null)).toBe(true);
  });

  it("persists a 25-track multi-page release and resumes without duplicates", async () => {
    const albumId = `album-pages-${randomUUID()}`;
    const startedAt = new Date("2026-07-21T20:00:00.000Z");
    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 25,
      finishedAt: new Date("2026-07-21T20:00:01.000Z"),
      items: Array.from({ length: 20 }, (_, index) => ({
        discNumber: 1,
        providerTrackId: `${albumId}-track-${index + 1}`,
        trackNumber: index + 1,
      })),
      nextOffset: 20,
      offset: 0,
      spotifyAlbumId: albumId,
      startedAt,
      terminal: false,
    });
    const partial = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
    });
    expect(partial).toMatchObject({
      fetchedTrackCount: 20,
      nextOffset: 20,
      pagesCompleted: 1,
      status: "partial",
    });
    expect((await loadSpotifyReleaseTrackResume(connection.db)).get(albumId)).toEqual({
      nextOffset: 20,
      status: "partial",
    });

    const finalPage = {
      expectedTotalTracks: 25,
      finishedAt: new Date("2026-07-21T20:01:01.000Z"),
      items: Array.from({ length: 5 }, (_, index) => ({
        discNumber: 2,
        providerTrackId: `${albumId}-track-${index + 21}`,
        trackNumber: index + 1,
      })),
      nextOffset: null,
      offset: 20,
      spotifyAlbumId: albumId,
      startedAt: new Date("2026-07-21T20:01:00.000Z"),
      terminal: true,
    } as const;
    await recordSpotifyReleaseTrackPage(connection.db, finalPage);
    await recordSpotifyReleaseTrackPage(connection.db, finalPage);

    const complete = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
    });
    expect(complete).toMatchObject({
      discrepancy: null,
      fetchedTrackCount: 25,
      nextOffset: null,
      pagesCompleted: 2,
      status: "completed",
    });
    expect(complete?.completedAt).toBeInstanceOf(Date);
    const retrievalId = complete!.id;
    expect(
      await connection.db
        .select()
        .from(spotifyReleaseTrackPages)
        .where(eq(spotifyReleaseTrackPages.retrievalId, retrievalId)),
    ).toHaveLength(2);
    const items = await connection.db
      .select()
      .from(spotifyReleaseTrackItems)
      .where(eq(spotifyReleaseTrackItems.retrievalId, retrievalId))
      .orderBy(asc(spotifyReleaseTrackItems.discNumber), asc(spotifyReleaseTrackItems.trackNumber));
    expect(items).toHaveLength(25);
    expect(items.at(-1)).toMatchObject({ discNumber: 2, trackNumber: 5 });
  });

  it("requires every track to be observed again before a new cycle becomes complete", async () => {
    const albumId = `album-cycle-${randomUUID()}`;
    const historicalItems = Array.from({ length: 23 }, (_, index) => ({
      discNumber: index >= 20 ? 2 : 1,
      providerTrackId: `${albumId}-track-${index + 1}`,
      trackNumber: index >= 20 ? index - 19 : index + 1,
    }));
    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 23,
      finishedAt: new Date("2026-07-20T20:00:01.000Z"),
      items: historicalItems,
      nextOffset: null,
      offset: 0,
      spotifyAlbumId: albumId,
      startedAt: new Date("2026-07-20T20:00:00.000Z"),
      terminal: true,
    });

    const reconciliationCycleId = randomUUID();
    await startSpotifyReleaseTrackRetrieval(connection.db, {
      expectedTotalTracks: 23,
      reconciliationCycleId,
      spotifyAlbumId: albumId,
    });
    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 23,
      finishedAt: new Date(),
      items: historicalItems.slice(0, 10),
      nextOffset: 10,
      offset: 0,
      reconciliationCycleId,
      spotifyAlbumId: albumId,
      startedAt: new Date(),
      terminal: false,
    });
    const firstPage = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
    });
    expect(firstPage).toMatchObject({
      fetchedTrackCount: 10,
      nextOffset: 10,
      pagesCompleted: 1,
      reconciliationCycleId,
      status: "partial",
    });

    await startSpotifyReleaseTrackRetrieval(connection.db, {
      expectedTotalTracks: 23,
      reconciliationCycleId,
      spotifyAlbumId: albumId,
    });
    const resumed = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
    });
    expect(resumed).toMatchObject({
      fetchedTrackCount: 10,
      nextOffset: 10,
      reconciliationCycleId,
      startedAt: firstPage?.startedAt,
      status: "in_progress",
    });

    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 23,
      finishedAt: new Date(),
      items: historicalItems.slice(10, 20),
      nextOffset: 20,
      offset: 10,
      reconciliationCycleId,
      spotifyAlbumId: albumId,
      startedAt: new Date(),
      terminal: false,
    });
    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 23,
      finishedAt: new Date(),
      items: historicalItems.slice(20),
      nextOffset: null,
      offset: 20,
      reconciliationCycleId,
      spotifyAlbumId: albumId,
      startedAt: new Date(),
      terminal: true,
    });
    expect(
      await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
        where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
      }),
    ).toMatchObject({ fetchedTrackCount: 23, pagesCompleted: 3, status: "completed" });
  });

  it("keeps a terminal total_tracks mismatch visible and resumable", async () => {
    const albumId = `album-mismatch-${randomUUID()}`;
    await recordSpotifyReleaseTrackPage(connection.db, {
      expectedTotalTracks: 3,
      finishedAt: new Date(),
      items: [
        { discNumber: 1, providerTrackId: `${albumId}-1`, trackNumber: 1 },
        { discNumber: 1, providerTrackId: `${albumId}-2`, trackNumber: 2 },
      ],
      nextOffset: null,
      offset: 0,
      spotifyAlbumId: albumId,
      startedAt: new Date(),
      terminal: true,
    });
    const state = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
    });
    expect(state).toMatchObject({
      discrepancy: "missing_1_tracks",
      fetchedTrackCount: 2,
      nextOffset: 0,
      status: "partial",
    });
    const summary = await spotifyReleaseTrackCompletenessSummary(connection.db);
    expect(summary.discrepancies).toBeGreaterThan(0);
    expect(summary.missingTracks).toBeGreaterThan(0);
  });

  it.each(["paused", "rate_limited", "failed"] as const)(
    "preserves completed pages and the resume cursor when retrieval becomes %s",
    async (status) => {
      const albumId = `album-interrupted-${status}-${randomUUID()}`;
      const startedAt = new Date();
      const finishedAt = new Date(startedAt.getTime() + 100);
      await recordSpotifyReleaseTrackPage(connection.db, {
        expectedTotalTracks: 25,
        finishedAt,
        items: Array.from({ length: 20 }, (_, index) => ({
          discNumber: 1,
          providerTrackId: `${albumId}-${index + 1}`,
          trackNumber: index + 1,
        })),
        nextOffset: 20,
        offset: 0,
        spotifyAlbumId: albumId,
        startedAt,
        terminal: false,
      });
      await markSpotifyReleaseTrackInterrupted(connection.db, {
        errorClassification:
          status === "paused"
            ? "request_budget_exhausted"
            : status === "rate_limited"
              ? "rate_limited"
              : "album_detail_failure",
        spotifyAlbumId: albumId,
        status,
      });
      const retrieval = await connection.db.query.spotifyReleaseTrackRetrievals.findFirst({
        where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, albumId),
      });
      expect(retrieval).toMatchObject({
        fetchedTrackCount: 20,
        nextOffset: 20,
        pagesCompleted: 1,
        status,
      });
    },
  );
});

describe.sequential("Spotify mapping resume and Keep separate", () => {
  it("blocks a missing or changed mapping and restores the expected mapping", async () => {
    // Use a canonical artist already linked by the test workflow to avoid unrelated fixture setup.
    const [knownArtist] = await connection.db.query.artists.findMany({ limit: 1 });
    expect(knownArtist).toBeDefined();
    const expectedSpotifyId = `spotify-expected-${randomUUID()}`;
    const batchId = await createSpotifyScanBatch(connection.db, {
      artists: [{ artistId: knownArtist!.id, spotifyArtistId: expectedSpotifyId }],
      confirmationRequired: false,
      estimatedRequests: 2,
      mode: "daily",
      pageLimit: 1,
    });

    await reconcileSpotifyBatchMappings(connection.db, batchId, []);
    let progress = await connection.db.query.spotifyArtistScans.findFirst({
      where: eq(spotifyArtistScans.batchId, batchId),
    });
    expect(progress).toMatchObject({
      errorClassification: "spotify_mapping_missing",
      status: "blocked_mapping",
    });
    await reconcileSpotifyBatchMappings(connection.db, batchId, [
      { artistId: knownArtist!.id, spotifyArtistId: `changed-${randomUUID()}` },
    ]);
    progress = await connection.db.query.spotifyArtistScans.findFirst({
      where: eq(spotifyArtistScans.batchId, batchId),
    });
    expect(progress).toMatchObject({
      errorClassification: "spotify_mapping_changed",
      status: "blocked_mapping",
    });
    await reconcileSpotifyBatchMappings(connection.db, batchId, [
      { artistId: knownArtist!.id, spotifyArtistId: expectedSpotifyId },
    ]);
    progress = await connection.db.query.spotifyArtistScans.findFirst({
      where: eq(spotifyArtistScans.batchId, batchId),
    });
    expect(progress).toMatchObject({ errorClassification: null, status: "pending" });
    const batch = await connection.db.query.spotifyScanBatches.findFirst({
      where: eq(spotifyScanBatches.id, batchId),
    });
    expect(batch?.blockedMappingArtists).toBe(0);
  });

  it("Keep separate creates a distinct canonical recording and retains evidence and feed state", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const suffix = randomUUID();
    const proposedIsrc = `USSEP${suffix.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    const [release] = await connection.db
      .insert(releases)
      .values({
        normalizedTitle: `review release ${suffix}`,
        releaseDate: "2026-07-21",
        releaseDatePrecision: "day",
        releaseType: "remix",
        title: `Review Release ${suffix}`,
      })
      .returning({ id: releases.id });
    const [proposedTrack] = await connection.db
      .insert(tracks)
      .values({
        isrc: proposedIsrc,
        normalizedTitle: `review track ${suffix}`,
        releaseId: release!.id,
        title: `Review Track ${suffix}`,
      })
      .returning({ id: tracks.id });
    const payload = candidate({
      externalReleaseId: `review-release-${suffix}`,
      externalTrackId: `review-track-${suffix}`,
      releaseTitle: `Review Release ${suffix}`,
      releaseType: "remix",
      isrc: proposedIsrc,
      title: `Review Track ${suffix} (Extended Mix)`,
      version: "extended mix",
    });
    const [reviewCandidate] = await connection.db
      .insert(releaseCandidates)
      .values({
        artistExternalId: payload.artistExternalId,
        firstSeenAt: new Date(payload.firstSeenAt),
        matchConfidence: "0.700",
        matchReasons: ["Synthetic ambiguous version"],
        matchRule: "metadata_review",
        matchStatus: "needs_review",
        matchedTrackId: proposedTrack!.id,
        normalizedTitle: payload.title.toLowerCase(),
        payloadHash: payload.payloadHash,
        provider: "spotify",
        providerReleaseId: payload.externalReleaseId,
        providerTrackId: payload.externalTrackId,
        rawPayload: payload,
        releaseDate: payload.releaseDate,
        title: payload.title,
      })
      .returning({ id: releaseCandidates.id });
    await connection.db.insert(sourceEvidence).values({
      candidateId: reviewCandidate!.id,
      evidenceType: payload.evidenceType,
      externalId: payload.externalTrackId,
      payloadHash: payload.payloadHash,
      provider: "spotify",
      sourceUrl: payload.evidenceUrl,
    });
    const [reviewFeed] = await connection.db
      .insert(feedItems)
      .values({
        candidateId: reviewCandidate!.id,
        dedupeKey: `spotify:${payload.externalReleaseId}:${payload.externalTrackId}`,
        firstSeenAt: new Date(payload.firstSeenAt),
        releaseId: release!.id,
        state: "needs_review",
        trackId: proposedTrack!.id,
        userId,
      })
      .returning({ id: feedItems.id });

    const beforeTracks = await connection.db.select().from(tracks);
    const result = await resolveFeedReview(connection.db, userId, reviewFeed!.id, "separate");
    const afterTracks = await connection.db.select().from(tracks);
    expect(result).toMatchObject({ decision: "separate", removed: false, state: "new" });
    expect(afterTracks).toHaveLength(beforeTracks.length + 1);
    const persistedFeed = await connection.db.query.feedItems.findFirst({
      where: eq(feedItems.id, reviewFeed!.id),
    });
    expect(typeof persistedFeed?.appearanceId).toBe("string");
    expect(persistedFeed?.state).toBe("new");
    expect(persistedFeed?.trackId).not.toBe(proposedTrack!.id);
    const separateTrack = await connection.db.query.tracks.findFirst({
      where: eq(tracks.id, persistedFeed!.trackId!),
    });
    expect(separateTrack?.isrc).toBeNull();
    expect(
      await connection.db
        .select()
        .from(sourceEvidence)
        .where(eq(sourceEvidence.candidateId, reviewCandidate!.id)),
    ).toHaveLength(1);
    expect(
      await connection.db
        .select()
        .from(manualMatchDecisions)
        .where(eq(manualMatchDecisions.candidateId, reviewCandidate!.id)),
    ).toEqual([
      expect.objectContaining({ decision: "separate", selectedTrackId: persistedFeed!.trackId }),
    ]);

    const repeated = await resolveFeedReview(connection.db, userId, reviewFeed!.id, "separate");
    expect(repeated).toMatchObject({ decision: "separate", removed: false, state: "new" });
    expect(await connection.db.select().from(tracks)).toHaveLength(afterTracks.length);
  });

  it("persists a seven-day review deferral without changing canonical identity", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const suffix = randomUUID();
    const [release] = await connection.db
      .insert(releases)
      .values({
        normalizedTitle: `deferred release ${suffix}`,
        releaseDate: "2026-08-27",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: `Deferred Release ${suffix}`,
      })
      .returning({ id: releases.id });
    const [track] = await connection.db
      .insert(tracks)
      .values({
        normalizedTitle: `deferred track ${suffix}`,
        releaseId: release!.id,
        title: `Deferred Track ${suffix}`,
      })
      .returning({ id: tracks.id });
    const payload = candidate({
      externalReleaseId: `deferred-release-${suffix}`,
      externalTrackId: `deferred-track-${suffix}`,
      releaseTitle: `Deferred Release ${suffix}`,
      title: `Deferred Track ${suffix}`,
    });
    const [reviewCandidate] = await connection.db
      .insert(releaseCandidates)
      .values({
        artistExternalId: payload.artistExternalId,
        firstSeenAt: new Date(payload.firstSeenAt),
        matchConfidence: "0.700",
        matchReasons: ["Synthetic ambiguous match"],
        matchRule: "metadata_review",
        matchStatus: "needs_review",
        matchedTrackId: track!.id,
        normalizedTitle: payload.title.toLowerCase(),
        payloadHash: payload.payloadHash,
        provider: "spotify",
        providerReleaseId: payload.externalReleaseId,
        providerTrackId: payload.externalTrackId,
        rawPayload: payload,
        releaseDate: payload.releaseDate,
        title: payload.title,
      })
      .returning({ id: releaseCandidates.id });
    const [feed] = await connection.db
      .insert(feedItems)
      .values({
        candidateId: reviewCandidate!.id,
        dedupeKey: `spotify:${payload.externalReleaseId}:${payload.externalTrackId}`,
        firstSeenAt: new Date(payload.firstSeenAt),
        releaseId: release!.id,
        state: "needs_review",
        trackId: track!.id,
        userId,
      })
      .returning({ id: feedItems.id });
    const now = new Date("2026-08-27T20:00:00.000Z");
    const result = await resolveFeedReview(connection.db, userId, feed!.id, "defer", {}, now);
    expect(result).toMatchObject({
      decision: "defer",
      deferredUntil: new Date("2026-09-03T20:00:00.000Z"),
      state: "needs_review",
    });
    const persisted = await connection.db.query.manualMatchDecisions.findFirst({
      where: eq(manualMatchDecisions.candidateId, reviewCandidate!.id),
    });
    expect(persisted).toMatchObject({
      decision: "defer",
      deferredUntil: new Date("2026-09-03T20:00:00.000Z"),
      selectedTrackId: track!.id,
    });
    expect(
      await connection.db.query.feedItems.findFirst({ where: eq(feedItems.id, feed!.id) }),
    ).toMatchObject({ state: "needs_review", trackId: track!.id });
  });

  it("resolves mirrored Apple and Spotify reviews as one atomic canonical group", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const beforeStatus = await getReleaseReviewQueueStatus(connection.db, userId);
    const suffix = randomUUID();
    const [release] = await connection.db
      .insert(releases)
      .values({
        normalizedTitle: `mirrored release ${suffix}`,
        releaseDate: "2026-08-28",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: `Mirrored Release ${suffix}`,
      })
      .returning({ id: releases.id });
    const [track] = await connection.db
      .insert(tracks)
      .values({
        normalizedTitle: `mirrored track ${suffix}`,
        releaseId: release!.id,
        title: `Mirrored Track ${suffix}`,
      })
      .returning({ id: tracks.id });
    const spotifyPayload = candidate({
      externalReleaseId: `spotify-mirrored-release-${suffix}`,
      externalTrackId: `spotify-mirrored-track-${suffix}`,
      releaseDate: "2026-08-28",
      releaseTitle: `Mirrored Release ${suffix}`,
      title: `Mirrored Track ${suffix}`,
    });
    const applePayload = candidate({
      artistExternalId: `apple-artist-${suffix}`,
      evidenceType: "apple_music_track",
      evidenceUrl: `https://music.apple.com/us/album/mirrored-${suffix}`,
      externalReleaseId: `apple-mirrored-release-${suffix}`,
      externalTrackId: `apple-mirrored-track-${suffix}`,
      payloadHash: `sha256:apple-${suffix}`,
      provider: "apple_music",
      providerUrl: `https://music.apple.com/us/album/mirrored-${suffix}`,
      releaseDate: "2026-08-28",
      releaseTitle: `Mirrored Release ${suffix}`,
      sourceLabel: "Synthetic Apple Music",
      title: `Mirrored Track ${suffix}`,
    });
    const insertedCandidates = [];
    for (const payload of [spotifyPayload, applePayload]) {
      const [inserted] = await connection.db
        .insert(releaseCandidates)
        .values({
          artistExternalId: payload.artistExternalId,
          firstSeenAt: new Date(payload.firstSeenAt),
          matchConfidence: "0.700",
          matchReasons: ["Synthetic mirrored review"],
          matchRule: "metadata_review",
          matchStatus: "needs_review",
          matchedTrackId: track!.id,
          normalizedTitle: payload.title.toLowerCase(),
          payloadHash: payload.payloadHash,
          provider: payload.provider,
          providerReleaseId: payload.externalReleaseId,
          providerTrackId: payload.externalTrackId,
          rawPayload: payload,
          releaseDate: payload.releaseDate,
          title: payload.title,
        })
        .returning({ id: releaseCandidates.id });
      insertedCandidates.push(inserted!);
    }
    const insertedFeedItems = [];
    for (const [index, insertedCandidate] of insertedCandidates.entries()) {
      const [inserted] = await connection.db
        .insert(feedItems)
        .values({
          candidateId: insertedCandidate.id,
          dedupeKey: `mirrored:${suffix}:${index}`,
          firstSeenAt: new Date("2026-08-28T09:00:00.000Z"),
          releaseId: release!.id,
          state: "needs_review",
          trackId: track!.id,
          userId,
        })
        .returning({ id: feedItems.id });
      insertedFeedItems.push(inserted!);
    }
    const groupedStatus = await getReleaseReviewQueueStatus(connection.db, userId);
    expect(groupedStatus.actionableCount).toBe(beforeStatus.actionableCount + 1);

    await connection.db
      .update(releaseCandidates)
      .set({ rawPayload: {} })
      .where(eq(releaseCandidates.id, insertedCandidates[1]!.id));
    await expect(
      resolveFeedReviewGroup(connection.db, userId, insertedFeedItems[0]!.id, "confirm"),
    ).rejects.toBeDefined();
    expect(
      await connection.db
        .select({ matchStatus: releaseCandidates.matchStatus })
        .from(releaseCandidates)
        .where(
          inArray(
            releaseCandidates.id,
            insertedCandidates.map((row) => row.id),
          ),
        ),
    ).toEqual([{ matchStatus: "needs_review" }, { matchStatus: "needs_review" }]);
    expect(
      await connection.db
        .select()
        .from(manualMatchDecisions)
        .where(
          inArray(
            manualMatchDecisions.candidateId,
            insertedCandidates.map((row) => row.id),
          ),
        ),
    ).toHaveLength(0);
    await connection.db
      .update(releaseCandidates)
      .set({ rawPayload: applePayload })
      .where(eq(releaseCandidates.id, insertedCandidates[1]!.id));

    const resolution = await resolveFeedReviewGroup(
      connection.db,
      userId,
      insertedFeedItems[1]!.id,
      "confirm",
    );
    expect(resolution?.affectedFeedItemIds).toEqual([
      insertedFeedItems[1]!.id,
      insertedFeedItems[0]!.id,
    ]);
    expect(
      await connection.db
        .select({ matchStatus: releaseCandidates.matchStatus })
        .from(releaseCandidates)
        .where(
          inArray(
            releaseCandidates.id,
            insertedCandidates.map((row) => row.id),
          ),
        ),
    ).toEqual([{ matchStatus: "matched" }, { matchStatus: "matched" }]);
    expect(
      await connection.db
        .select()
        .from(manualMatchDecisions)
        .where(
          inArray(
            manualMatchDecisions.candidateId,
            insertedCandidates.map((row) => row.id),
          ),
        ),
    ).toHaveLength(2);
    expect(
      await connection.db
        .select({ externalId: trackExternalIds.externalId, provider: trackExternalIds.provider })
        .from(trackExternalIds)
        .where(eq(trackExternalIds.trackId, track!.id)),
    ).toEqual(
      expect.arrayContaining([
        { externalId: spotifyPayload.externalTrackId, provider: "spotify" },
        { externalId: applePayload.externalTrackId, provider: "apple_music" },
      ]),
    );
    expect(
      await connection.db
        .select()
        .from(releaseTrackAppearanceSources)
        .where(
          inArray(
            releaseTrackAppearanceSources.candidateId,
            insertedCandidates.map((row) => row.id),
          ),
        ),
    ).toHaveLength(2);
    const remainingGroupFeeds = await connection.db
      .select()
      .from(feedItems)
      .where(
        inArray(
          feedItems.id,
          insertedFeedItems.map((row) => row.id),
        ),
      );
    expect(remainingGroupFeeds).toHaveLength(1);
    expect(remainingGroupFeeds[0]).toMatchObject({ state: "new", trackId: track!.id });
  });
});

function candidate(overrides: Partial<TrackCandidate> = {}): TrackCandidate {
  const suffix = randomUUID();
  const base: TrackCandidate = {
    artistExternalId: `spotify-artist-${suffix}`,
    artistName: `Integrity Artist ${suffix}`,
    availability: "playable",
    credits: [{ name: `Integrity Artist ${suffix}`, role: "primary" }],
    discNumber: 1,
    durationMs: 180_000,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/evidence-${suffix}`,
    externalReleaseId: `release-${suffix}`,
    externalTrackId: `track-${suffix}`,
    firstSeenAt: "2026-07-21T20:00:00.000Z",
    payloadHash: `sha256:${suffix}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/track-${suffix}`,
    region: "US",
    releaseDate: "2026-07-21",
    releaseDatePrecision: "day",
    releaseTitle: `Integrity Release ${suffix}`,
    releaseType: "single",
    sourceLabel: "Synthetic Spotify",
    title: `Integrity Track ${suffix}`,
    trackNumber: 1,
  };
  return { ...base, ...overrides };
}
