import {
  artistExternalIds,
  artistFollows,
  artists,
  acquireOperationLock,
  attachMusicBrainzBatchScanRun,
  confirmSpotifyImport,
  consumeOAuthState,
  createDatabase,
  createMusicBrainzRequestGate,
  createMusicBrainzBatch,
  createSpotifyImportRun,
  decideMusicBrainzArtistMapping,
  disconnectSpotifyAccount,
  expireDetailedScanData,
  ensureLocalOwner,
  feedItems,
  artistMappingReviews,
  listRedditSources,
  heartbeatOperationLock,
  listFollowedArtists,
  manualMatchDecisions,
  operationCancellationRequested,
  operationLocks,
  musicbrainzArtistScans,
  musicbrainzProviderState,
  musicbrainzRequestEvents,
  loadMusicBrainzBatchArtistIds,
  startMusicBrainzArtist,
  recordMusicBrainzStage,
  finishMusicBrainzBatch,
  persistOAuthState,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  releases,
  redditCandidateMatches,
  redditExternalLinks,
  releaseOperationLock,
  resolveFeedReview,
  requestOperationCancellation,
  scanLocks,
  sourceEvidence,
  tracks,
  trackCredits,
  trackAvailabilities,
  trackExternalIds,
  persistRedditListing,
  purgeDeletedRedditSubmissions,
  scanRuns,
  unlockStaleOperations,
  upsertSpotifyAccount,
  updateFeedPreferences,
} from "@radar/db";
import type { TrackCandidate } from "@radar/core";
import { encryptSecret } from "@radar/providers";
import { mockProviderFixture, syntheticRedditListing } from "@radar/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSpotifyDryRunReport, persistCandidates, runScan } from "./scan";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

const integrationSpotifyCandidates: TrackCandidate[] = [
  {
    artistExternalId: "spotify-lumen",
    artistName: "Lumen Field",
    availability: "playable",
    credits: [{ name: "Lumen Field", role: "primary" }],
    durationMs: 201_000,
    evidenceType: "synthetic_spotify_album",
    evidenceUrl: "https://example.test/evidence/album-track-1",
    externalReleaseId: "spotify-album-integration",
    externalTrackId: "spotify-album-track-1",
    firstSeenAt: "2026-07-15T10:00:00.000Z",
    isrc: "USINT2600001",
    payloadHash: "sha256:spotify-album-track-1",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/spotify-album-track-1",
    region: "US",
    releaseDate: "2026-07-15",
    releaseDatePrecision: "day",
    releaseTitle: "Integration Album",
    releaseType: "album",
    sourceLabel: "Synthetic Spotify",
    title: "Album Track One",
  },
  {
    artistExternalId: "spotify-lumen",
    artistName: "Lumen Field",
    availability: "playable",
    credits: [{ name: "Lumen Field", role: "primary" }],
    durationMs: 203_000,
    evidenceType: "synthetic_spotify_album",
    evidenceUrl: "https://example.test/evidence/album-track-2",
    externalReleaseId: "spotify-album-integration",
    externalTrackId: "spotify-album-track-2",
    firstSeenAt: "2026-07-15T10:00:00.000Z",
    isrc: "USINT2600002",
    payloadHash: "sha256:spotify-album-track-2",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/spotify-album-track-2",
    region: "US",
    releaseDate: "2026-07-15",
    releaseDatePrecision: "day",
    releaseTitle: "Integration Album",
    releaseType: "album",
    sourceLabel: "Synthetic Spotify",
    title: "Album Track Two",
  },
  {
    artistExternalId: "spotify-mara",
    artistName: "Mara Voss",
    availability: "playable",
    credits: [
      { name: "Mara Voss", role: "primary" },
      { name: "Lumen Field", role: "featured" },
    ],
    durationMs: 215_000,
    evidenceType: "synthetic_spotify_feature",
    evidenceUrl: "https://example.test/evidence/featured-appearance",
    externalReleaseId: "spotify-feature-integration",
    externalTrackId: "spotify-feature-track",
    firstSeenAt: "2026-07-15T10:05:00.000Z",
    isrc: "USINT2600003",
    payloadHash: "sha256:spotify-feature-track",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/spotify-feature-track",
    region: "US",
    releaseDate: "2026-07-14",
    releaseDatePrecision: "day",
    releaseTitle: "Featured Appearance",
    releaseType: "feature",
    sourceLabel: "Synthetic Spotify",
    title: "Featured Appearance",
  },
  {
    artistExternalId: "spotify-oxide",
    artistName: "Oxide Echo",
    availability: "playable",
    credits: [{ name: "Oxide Echo", role: "primary" }],
    durationMs: 190_000,
    evidenceType: "synthetic_spotify_single",
    evidenceUrl: "https://example.test/evidence/original",
    externalReleaseId: "spotify-original-integration",
    externalTrackId: "spotify-original-track",
    firstSeenAt: "2026-07-15T10:10:00.000Z",
    isrc: "USINT2600004",
    payloadHash: "sha256:spotify-original-track",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/spotify-original-track",
    region: "US",
    releaseDate: "2026-07-13",
    releaseDatePrecision: "day",
    releaseTitle: "Pulse Vector",
    releaseType: "single",
    sourceLabel: "Synthetic Spotify",
    title: "Pulse Vector",
  },
  {
    artistExternalId: "spotify-oxide",
    artistName: "Oxide Echo",
    availability: "playable",
    credits: [{ name: "Oxide Echo", role: "primary" }],
    durationMs: 242_000,
    evidenceType: "synthetic_spotify_remix",
    evidenceUrl: "https://example.test/evidence/remix",
    externalReleaseId: "spotify-remix-integration",
    externalTrackId: "spotify-remix-track",
    firstSeenAt: "2026-07-15T10:11:00.000Z",
    payloadHash: "sha256:spotify-remix-track",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/spotify-remix-track",
    region: "US",
    releaseDate: "2026-07-13",
    releaseDatePrecision: "day",
    releaseTitle: "Pulse Vector (Extended Remix)",
    releaseType: "remix",
    sourceLabel: "Synthetic Spotify",
    title: "Pulse Vector (Extended Remix)",
    version: "extended remix",
  },
];

const integrationMusicBrainzDuplicate: TrackCandidate = {
  ...integrationSpotifyCandidates[3]!,
  availability: "unavailable",
  evidenceType: "synthetic_musicbrainz_recording",
  evidenceUrl: "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000004",
  externalReleaseId: "musicbrainz-release-integration",
  externalTrackId: "musicbrainz-recording-integration",
  firstSeenAt: "2026-07-15T11:00:00.000Z",
  musicbrainzRecordingId: "00000000-0000-4000-8000-000000000004",
  payloadHash: "sha256:musicbrainz-recording-integration",
  provider: "musicbrainz",
  providerUrl: "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000004",
  sourceLabel: "Synthetic MusicBrainz",
};

describe.sequential("complete deterministic fake-provider workflow", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, tracks, scan_runs restart identity cascade`,
    );
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("is idempotent, merges ISRC duplicates, and creates review feed items", async () => {
    const first = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );
    const second = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );

    expect(first).toMatchObject({ inserted: 5, needsReview: 1 });
    expect(second).toMatchObject({ inserted: 0, skipped: 5 });
    expect(await connection.db.select().from(releaseCandidates)).toHaveLength(5);
    expect(await connection.db.select().from(tracks)).toHaveLength(3);
    expect(await connection.db.select().from(sourceEvidence)).toHaveLength(5);
    expect(
      (await connection.db.select().from(feedItems)).some((item) => item.state === "needs_review"),
    ).toBe(true);

    const spotify = await persistCandidates(connection.db, integrationSpotifyCandidates, {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
    const musicBrainz = await persistCandidates(connection.db, [integrationMusicBrainzDuplicate], {
      dryRun: false,
      full: false,
      provider: "musicbrainz",
    });
    const spotifyRerun = await persistCandidates(connection.db, integrationSpotifyCandidates, {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
    expect(spotify).toMatchObject({ inserted: 5 });
    expect(musicBrainz).toMatchObject({ inserted: 1 });
    expect(spotifyRerun).toMatchObject({ inserted: 0, skipped: 5 });
    const completeTracks = await connection.db.select().from(tracks);
    const [isrcTrack] = completeTracks.filter((track) => track.isrc === "USINT2600004");
    expect(isrcTrack).toBeDefined();
    expect(completeTracks.filter((track) => track.isrc === "USINT2600004")).toHaveLength(1);
    expect(
      (await connection.db.select().from(feedItems)).filter(
        (item) => item.trackId === isrcTrack!.id,
      ),
    ).toHaveLength(1);
    expect(
      completeTracks.some((track) => track.normalizedTitle === "pulse vector extended remix"),
    ).toBe(true);
    expect(completeTracks.some((track) => track.normalizedTitle === "pulse vector")).toBe(true);
  });

  it("persists saved and listened preferences independently", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const [feed] = await connection.db.select().from(feedItems).limit(1);
    expect(feed).toBeDefined();
    const originalState = feed!.state;

    const saved = await updateFeedPreferences(connection.db, userId, feed!.id, { saved: true });
    expect(saved).toMatchObject({ listened: false, saved: true });

    const listened = await updateFeedPreferences(connection.db, userId, feed!.id, {
      listened: true,
    });
    expect(listened).toMatchObject({ listened: true, saved: true });

    const unsaved = await updateFeedPreferences(connection.db, userId, feed!.id, { saved: false });
    expect(unsaved).toMatchObject({ listened: true, saved: false });

    const unlistened = await updateFeedPreferences(connection.db, userId, feed!.id, {
      listened: false,
    });
    expect(unlistened).toMatchObject({ listened: false, saved: false, state: originalState });
  });

  it("uses one database-backed MusicBrainz queue across concurrent callers", async () => {
    await connection.db.delete(musicbrainzRequestEvents);
    await connection.db.delete(musicbrainzProviderState);
    const firstGate = createMusicBrainzRequestGate(connection.db, 1_000);
    const secondGate = createMusicBrainzRequestGate(connection.db, 1_000);
    const firstPromise = firstGate.acquire({
      endpointCategory: "artist_search",
      method: "GET",
      retryAttempt: 1,
    });
    const secondPromise = secondGate.acquire({
      endpointCategory: "release_browse",
      method: "GET",
      retryAttempt: 1,
    });
    const first = await firstPromise;
    await firstGate.complete(first, { status: 200 });
    const second = await secondPromise;
    expect(Math.abs(second.startedAt.getTime() - first.startedAt.getTime())).toBeGreaterThanOrEqual(
      900,
    );
    await secondGate.complete(second, { status: 200 });
    const events = await connection.db.select().from(musicbrainzRequestEvents);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.status === 200)).toBe(true);
  });

  it("resumes only incomplete MusicBrainz artists after cancellation and restart", async () => {
    const artistRows = await connection.db
      .insert(artists)
      .values([
        { name: "Batch Artist One", normalizedName: "batch artist one" },
        { name: "Batch Artist Two", normalizedName: "batch artist two" },
      ])
      .onConflictDoNothing()
      .returning({ id: artists.id });
    expect(artistRows).toHaveLength(2);
    const [firstArtist, secondArtist] = artistRows;
    const batchId = await createMusicBrainzBatch(connection.db, [
      firstArtist!.id,
      secondArtist!.id,
    ]);
    expect(await startMusicBrainzArtist(connection.db, batchId, firstArtist!.id)).toBe(true);
    await recordMusicBrainzStage(connection.db, {
      artistId: firstArtist!.id,
      batchId,
      candidateCount: 1,
      releaseCount: 2,
      requestCount: 3,
      stage: "track_appearances",
    });
    expect(await startMusicBrainzArtist(connection.db, batchId, secondArtist!.id)).toBe(true);
    await recordMusicBrainzStage(connection.db, {
      artistId: secondArtist!.id,
      batchId,
      candidateCount: 0,
      releaseGroupCount: 5,
      requestCount: 1,
      stage: "release_groups",
    });
    await finishMusicBrainzBatch(connection.db, batchId, "cancelled");

    expect(await loadMusicBrainzBatchArtistIds(connection.db, batchId)).toEqual([secondArtist!.id]);
    const [resumeRun] = await connection.db
      .insert(scanRuns)
      .values({ provider: "musicbrainz" })
      .returning({ id: scanRuns.id });
    await attachMusicBrainzBatchScanRun(connection.db, batchId, resumeRun!.id);
    const resumedBatch = await connection.db.query.musicbrainzScanBatches.findFirst({
      where: (table, { eq }) => eq(table.id, batchId),
    });
    expect(resumedBatch).toMatchObject({
      cancelledArtists: 0,
      completedArtists: 1,
      failedArtists: 0,
      status: "running",
    });
    const resumedArtist = await connection.db.query.musicbrainzArtistScans.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.batchId, batchId), eq(table.artistId, secondArtist!.id)),
    });
    expect(resumedArtist).toMatchObject({
      candidateCount: 0,
      releaseCount: 0,
      releaseGroupCount: 0,
      requestCount: 0,
      stage: "pending",
      status: "pending",
    });
    expect(await startMusicBrainzArtist(connection.db, batchId, secondArtist!.id)).toBe(true);
    await recordMusicBrainzStage(connection.db, {
      artistId: secondArtist!.id,
      batchId,
      candidateCount: 0,
      releaseCount: 0,
      requestCount: 3,
      stage: "track_appearances",
    });
    await finishMusicBrainzBatch(connection.db, batchId, "completed");
    expect(await loadMusicBrainzBatchArtistIds(connection.db, batchId)).toEqual([]);
    expect(
      await connection.db.query.musicbrainzScanBatches.findFirst({
        where: (table, { eq }) => eq(table.id, batchId),
      }),
    ).toMatchObject({
      cancelledArtists: 0,
      completedArtists: 2,
      failedArtists: 0,
      status: "completed",
    });
  });

  it("consumes OAuth state exactly once and rejects expired state", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const validId = await persistOAuthState(connection.db, {
      encryptedVerifier: { ciphertext: "cipher", nonce: "nonce" },
      expiresAt: new Date(Date.now() + 60_000),
      stateHash: "valid-hash",
      userId,
    });
    expect(await consumeOAuthState(connection.db, validId, "valid-hash")).toEqual({
      ciphertext: "cipher",
      nonce: "nonce",
    });
    expect(await consumeOAuthState(connection.db, validId, "valid-hash")).toBeUndefined();

    const expiredId = await persistOAuthState(connection.db, {
      encryptedVerifier: { ciphertext: "expired", nonce: "nonce" },
      expiresAt: new Date(Date.now() - 1),
      stateHash: "expired-hash",
      userId,
    });
    expect(await consumeOAuthState(connection.db, expiredId, "expired-hash")).toBeUndefined();

    const key = Buffer.alloc(32, 7).toString("base64");
    await upsertSpotifyAccount(connection.db, {
      accessToken: encryptSecret("fake-access", key),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      providerAccountId: "spotify-account-integration",
      refreshToken: encryptSecret("fake-refresh", key),
      scopes: ["user-follow-read", "playlist-read-private"],
      userId,
    });
  });

  it("deduplicates repeated Spotify imports by provider artist ID", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const preview = [
      {
        providerArtistId: "spotify-artist-integration",
        providerName: "Integration Artist",
        providerUrl: "https://open.spotify.com/artist/spotify-artist-integration",
        proposedAction: "create" as const,
        selected: true,
      },
    ];
    const firstRun = await createSpotifyImportRun(connection.db, userId, preview);
    const firstCandidate = await connection.db.query.artistImportCandidates.findFirst({
      where: (table, { eq }) => eq(table.importRunId, firstRun),
    });
    expect(firstCandidate).toBeDefined();
    await confirmSpotifyImport(connection.db, userId, firstRun, [
      {
        candidateId: firstCandidate!.id,
        decision: "create",
        selected: true,
      },
    ]);

    const secondRun = await createSpotifyImportRun(connection.db, userId, preview);
    const secondCandidate = await connection.db.query.artistImportCandidates.findFirst({
      where: (table, { eq }) => eq(table.importRunId, secondRun),
    });
    await confirmSpotifyImport(connection.db, userId, secondRun, [
      {
        candidateId: secondCandidate!.id,
        decision: "create",
        selected: true,
      },
    ]);
    const mappings = await connection.db.query.artistExternalIds.findMany({
      where: (table, { and, eq }) =>
        and(eq(table.provider, "spotify"), eq(table.externalId, "spotify-artist-integration")),
    });
    expect(mappings).toHaveLength(1);
    expect(
      (await connection.db.select().from(artists)).filter(
        (artist) => artist.normalizedName === "integration artist",
      ),
    ).toHaveLength(1);

    const lumen = (await connection.db.select().from(artists)).find(
      (artist) => artist.normalizedName === "lumen field",
    );
    const oxide = (await connection.db.select().from(artists)).find(
      (artist) => artist.normalizedName === "oxide echo",
    );
    expect(lumen).toBeDefined();
    expect(oxide).toBeDefined();
    await connection.db.insert(artistExternalIds).values({
      artistId: lumen!.id,
      confirmed: true,
      externalId: "00000000-0000-4000-8000-000000000001",
      matchReasons: ["Synthetic exact mapping"],
      matchScore: "1.000",
      mappingSource: "manual_confirmation",
      provider: "musicbrainz",
      providerUrl: "https://musicbrainz.org/artist/00000000-0000-4000-8000-000000000001",
    });
    await connection.db.insert(artistMappingReviews).values({
      artistId: oxide!.id,
      matchReasons: ["Synthetic ambiguous name"],
      matchScore: "0.720",
      proposedExternalId: "00000000-0000-4000-8000-000000000002",
      provider: "musicbrainz",
      providerName: "Oxide Echoes",
    });
    expect(await connection.db.select().from(artistMappingReviews)).toHaveLength(1);
  });

  it("cancels a short MusicBrainz scan at the first forced progress checkpoint", async () => {
    const lumen = (await connection.db.select().from(artists)).find(
      (artist) => artist.normalizedName === "lumen field",
    );
    expect(lumen).toBeDefined();
    let requestCount = 0;
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("MUSICBRAINZ_ENABLED", "true");
    vi.stubEnv("MUSICBRAINZ_CONTACT_EMAIL", "integration@example.invalid");
    vi.stubGlobal("fetch", async () => {
      requestCount += 1;
      expect(await requestOperationCancellation(connection.db, "scan:global")).toBe(true);
      return new Response(
        JSON.stringify({
          "release-group-count": 0,
          "release-group-offset": 0,
          "release-groups": [],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    });

    try {
      await expect(
        runScan({
          artistId: lumen!.id,
          dryRun: false,
          full: false,
          provider: "musicbrainz",
          spotifyConfirmBatch: false,
          spotifyMode: "daily",
        }),
      ).rejects.toThrow("Scan cancelled by the user");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    expect(requestCount).toBe(1);
    const batch = await connection.db.query.musicbrainzScanBatches.findFirst({
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    expect(batch).toMatchObject({
      cancelledArtists: 1,
      completedArtists: 0,
      status: "cancelled",
      totalArtists: 1,
    });
    const [artistScan] = await connection.db
      .select()
      .from(musicbrainzArtistScans)
      .where(sql`${musicbrainzArtistScans.batchId} = ${batch!.id}`);
    expect(artistScan).toMatchObject({
      releaseGroupCount: 0,
      stage: "release_groups",
      status: "cancelled",
    });
    expect(
      await connection.db.query.operationLocks.findFirst({
        where: (table, { eq }) => eq(table.lockKey, "scan:global"),
      }),
    ).toBeUndefined();
  });

  it("builds a structured Spotify dry-run report without canonical writes", async () => {
    const before = {
      candidates: (await connection.db.select().from(releaseCandidates)).length,
      evidence: (await connection.db.select().from(sourceEvidence)).length,
      feed: (await connection.db.select().from(feedItems)).length,
      releases: (await connection.db.select().from(releases)).length,
      tracks: (await connection.db.select().from(tracks)).length,
    };
    const report = await createSpotifyDryRunReport(connection.db, {
      backfillStart: "2026-05-19",
      candidates: integrationSpotifyCandidates,
      pagesScanned: 1,
      partial: true,
      releases: [
        {
          backfillEligible: true,
          candidateCount: integrationSpotifyCandidates.length,
          externalReleaseId: "spotify-album-integration",
          reasons: ["Synthetic release is inside the backfill"],
          releaseDate: "2026-07-15",
          releaseDatePrecision: "day",
          releaseType: "album",
          selectedForDetails: true,
          title: "Integration Album",
          totalTracks: 2,
        },
      ],
      requestCount: 3,
    });

    expect(report).toMatchObject({
      discovery: { pagesScanned: 1, partial: true, requestCount: 3, status: "succeeded" },
      persistence: { canonicalWrites: 0, status: "skipped" },
      releases: [{ releaseDate: "2026-07-15", title: "Integration Album" }],
    });
    expect(report.trackCandidates).toHaveLength(integrationSpotifyCandidates.length);
    expect({
      candidates: (await connection.db.select().from(releaseCandidates)).length,
      evidence: (await connection.db.select().from(sourceEvidence)).length,
      feed: (await connection.db.select().from(feedItems)).length,
      releases: (await connection.db.select().from(releases)).length,
      tracks: (await connection.db.select().from(tracks)).length,
    }).toEqual(before);
  });

  it("persists MusicBrainz confirmations idempotently and resolves replacement reviews", async () => {
    const [artist] = await connection.db
      .insert(artists)
      .values({ name: "Mapping Decision Artist", normalizedName: "mapping decision artist" })
      .returning({ id: artists.id });
    const userId = await ensureLocalOwner(connection.db);
    await connection.db.insert(artistFollows).values({ artistId: artist!.id, userId });
    const [first, replacement] = await connection.db
      .insert(artistMappingReviews)
      .values([
        {
          artistId: artist!.id,
          matchReasons: ["Synthetic exact mapping"],
          matchScore: "0.990",
          proposedExternalId: "00000000-0000-4000-8000-000000000011",
          provider: "musicbrainz",
          providerName: "Mapping Decision Artist",
        },
        {
          artistId: artist!.id,
          matchReasons: ["Synthetic replacement mapping"],
          matchScore: "0.850",
          proposedExternalId: "00000000-0000-4000-8000-000000000012",
          provider: "musicbrainz",
          providerName: "Mapping Decision Artist Two",
        },
      ])
      .returning({ id: artistMappingReviews.id });

    const confirmed = await decideMusicBrainzArtistMapping(connection.db, {
      decision: "confirm",
      reviewId: first!.id,
    });
    expect(confirmed).toMatchObject({
      decision: "confirm",
      externalId: "00000000-0000-4000-8000-000000000011",
      idempotent: false,
    });
    const persisted = await connection.db.query.artistExternalIds.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.artistId, artist!.id), eq(table.provider, "musicbrainz")),
    });
    expect(persisted).toMatchObject({
      confirmed: true,
      externalId: "00000000-0000-4000-8000-000000000011",
      mappingSource: "user_confirmed_musicbrainz",
    });
    const firstConfirmedAt = persisted!.confirmedAt;
    const resolvedReviews = await connection.db.query.artistMappingReviews.findMany({
      where: (table, { eq }) => eq(table.artistId, artist!.id),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    expect(
      Object.fromEntries(
        resolvedReviews.map((review) => [review.proposedExternalId, review.status]),
      ),
    ).toEqual({
      "00000000-0000-4000-8000-000000000011": "confirmed",
      "00000000-0000-4000-8000-000000000012": "rejected",
    });
    expect(resolvedReviews.every((review) => review.decidedAt instanceof Date)).toBe(true);

    const reconfirmed = await decideMusicBrainzArtistMapping(connection.db, {
      decision: "confirm",
      reviewId: first!.id,
    });
    expect(reconfirmed.idempotent).toBe(true);
    expect(
      (
        await connection.db.query.artistExternalIds.findFirst({
          where: (table, { and, eq }) =>
            and(eq(table.artistId, artist!.id), eq(table.provider, "musicbrainz")),
        })
      )?.confirmedAt,
    ).toEqual(firstConfirmedAt);

    const replaced = await decideMusicBrainzArtistMapping(connection.db, {
      decision: "confirm",
      reviewId: replacement!.id,
    });
    expect(replaced).toMatchObject({
      externalId: "00000000-0000-4000-8000-000000000012",
      idempotent: false,
    });
    expect(
      await connection.db.query.artistExternalIds.findMany({
        where: (table, { eq }) => eq(table.artistId, artist!.id),
      }),
    ).toMatchObject([{ confirmed: true, externalId: "00000000-0000-4000-8000-000000000012" }]);
    expect(
      await connection.db.query.artistMappingReviews.findMany({
        where: (table, { eq }) => eq(table.artistId, artist!.id),
        orderBy: (table, { asc }) => [asc(table.createdAt)],
      }),
    ).toMatchObject([{ status: "rejected" }, { status: "confirmed" }]);

    const reloadedConnection = createDatabase(databaseUrl);
    try {
      const reloaded = await listFollowedArtists(reloadedConnection.db, userId);
      expect(reloaded.find((entry) => entry.artistId === artist!.id)?.providers).toContain(
        "musicbrainz",
      );
    } finally {
      await reloadedConnection.client.end();
    }
  });

  it("encrypts tokens, deletes them on disconnect, and preserves canonical data", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const key = Buffer.alloc(32, 7).toString("base64");
    await upsertSpotifyAccount(connection.db, {
      accessToken: encryptSecret("access", key),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      providerAccountId: "spotify-account-integration",
      refreshToken: encryptSecret("refresh", key),
      scopes: ["user-follow-read"],
      userId,
    });
    const stored = await connection.db.query.oauthAccounts.findFirst({
      where: (table, { eq }) => eq(table.providerAccountId, "spotify-account-integration"),
    });
    expect(stored?.encryptedRefreshToken).not.toContain("refresh");
    const artistCount = (await connection.db.select().from(artists)).length;
    await disconnectSpotifyAccount(connection.db, userId);
    const disconnected = await connection.db.query.oauthAccounts.findFirst({
      where: (table, { eq }) => eq(table.providerAccountId, "spotify-account-integration"),
    });
    expect(disconnected).toMatchObject({
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
    });
    expect(disconnected?.disconnectedAt).toBeInstanceOf(Date);
    expect(await connection.db.select().from(artists)).toHaveLength(artistCount);
  });

  it("enforces one playlist addition and recovers an expired scan lock", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const [track] = await connection.db.select().from(tracks);
    expect(track).toBeDefined();
    const [target] = await connection.db
      .insert(playlistTargets)
      .values({ name: "Integration inbox", provider: "spotify", userId })
      .returning({ id: playlistTargets.id });
    expect(target).toBeDefined();
    const exportValue = {
      playlistTargetId: target!.id,
      providerTrackId: "spotify-track-integration",
      status: "exported" as const,
      trackId: track!.id,
    };
    await connection.db.insert(playlistExports).values(exportValue);
    await connection.db.insert(playlistExports).values(exportValue).onConflictDoNothing();
    expect(await connection.db.select().from(playlistExports)).toHaveLength(1);

    await connection.db.insert(scanLocks).values({
      acquiredAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      ownerToken: "interrupted-run",
      provider: "mock",
    });
    const recovered = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );
    expect(recovered.skipped).toBe(5);
    expect(await connection.db.select().from(scanLocks)).toHaveLength(0);
  });

  it("serializes normal scans, recovers stale operation locks, and expires only details", async () => {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "scan:global",
      operationType: "normal_scan",
      ttlMs: 60_000,
    });
    await expect(
      acquireOperationLock(connection.db, {
        lockKey: "scan:global",
        operationType: "provider_scan",
      }),
    ).rejects.toThrow("already running");
    await releaseOperationLock(connection.db, lock);

    await connection.db.insert(operationLocks).values({
      acquiredAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      lockKey: "scan:interrupted",
      metadata: {},
      operationType: "normal_scan",
      ownerToken: "interrupted-owner",
    });
    expect(await unlockStaleOperations(connection.db)).toBe(1);

    const [expired] = await connection.db
      .insert(scanRuns)
      .values({
        completedAt: new Date(),
        detailedExpiresAt: new Date(Date.now() - 1),
        discoveredCount: 9,
        errors: [{ message: "expired detail" }],
        metadata: { providerMetrics: { waitMs: 20 } },
        provider: "mock",
        providerResults: { mock: { discovered: 9 } },
        status: "completed",
      })
      .returning({ id: scanRuns.id });
    expect(await expireDetailedScanData(connection.db)).toBe(1);
    const retained = await connection.db.query.scanRuns.findFirst({
      where: (table, { eq }) => eq(table.id, expired!.id),
    });
    expect(retained).toMatchObject({
      discoveredCount: 9,
      errors: [],
      metadata: {},
      providerResults: {},
      status: "completed",
    });
  });

  it("heartbeats an active scan lock and records cooperative cancellation", async () => {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "scan:cancellation-test",
      operationType: "provider_scan",
      ttlMs: 1_000,
    });
    const before = await connection.db.query.operationLocks.findFirst({
      where: (table, { eq }) => eq(table.lockKey, "scan:cancellation-test"),
    });

    expect(
      await heartbeatOperationLock(
        connection.db,
        lock,
        { completedUnits: 4, currentUnit: "YUSSI" },
        60_000,
      ),
    ).toBe(true);
    expect(await requestOperationCancellation(connection.db, lock.lockKey)).toBe(true);
    expect(await operationCancellationRequested(connection.db, lock)).toBe(true);

    const after = await connection.db.query.operationLocks.findFirst({
      where: (table, { eq }) => eq(table.lockKey, "scan:cancellation-test"),
    });
    expect(after?.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    expect(after?.metadata).toMatchObject({
      cancelRequested: true,
      completedUnits: 4,
      currentUnit: "YUSSI",
    });
    await releaseOperationLock(connection.db, lock);
  });

  it("persists mocked Reddit evidence idempotently and purges deleted source content", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const [spotifyBackedTrack] = await connection.db
      .select({ id: tracks.id })
      .from(tracks)
      .innerJoin(trackCredits, eq(trackCredits.trackId, tracks.id))
      .innerJoin(artists, eq(artists.id, trackCredits.artistId))
      .where(
        and(eq(tracks.normalizedTitle, "glass horizon"), eq(artists.normalizedName, "lumen field")),
      )
      .limit(1);
    expect(spotifyBackedTrack).toBeDefined();
    await connection.db
      .insert(trackAvailabilities)
      .values({
        provider: "spotify",
        providerTrackId: "spotify-glass-horizon-integration",
        providerUrl: "https://open.spotify.com/track/spotify-glass-horizon-integration",
        region: "US",
        state: "playable",
        trackId: spotifyBackedTrack!.id,
      })
      .onConflictDoNothing();
    const sources = await listRedditSources(connection.db, userId);
    const source = sources.find((entry) => entry.subreddit === "EDM");
    expect(source).toBeDefined();
    const first = await persistRedditListing(
      connection.db,
      userId,
      source!.id,
      syntheticRedditListing,
    );
    const second = await persistRedditListing(
      connection.db,
      userId,
      source!.id,
      syntheticRedditListing,
    );
    expect(first.insertedSubmissions).toBe(2);
    expect(first.needsReview).toBeGreaterThan(0);
    expect(second.insertedSubmissions).toBe(0);
    expect(second.duplicates).toBe(2);
    const redditMatches = await connection.db.select().from(redditCandidateMatches);
    expect(redditMatches.some((match) => match.reviewStatus === "corroborated")).toBe(true);
    expect(redditMatches.some((match) => match.reviewStatus === "needs_review")).toBe(true);
    expect(await connection.db.select().from(redditExternalLinks)).not.toHaveLength(0);

    const purge = await purgeDeletedRedditSubmissions(connection.db, ["t3_fixture1"]);
    expect(purge.deleted).toBe(1);
    const deleted = await connection.db.query.redditSubmissions.findFirst({
      where: (table, { eq }) => eq(table.fullname, "t3_fixture1"),
    });
    expect(deleted).toMatchObject({
      destinationUrl: null,
      permalink: null,
      selfText: null,
      sourceState: "deleted",
      title: null,
    });
  });

  it("persists a review confirmation and retains its release appearance", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const reviewFeed = await connection.db.query.feedItems.findFirst({
      where: (table, { eq }) => eq(table.state, "needs_review"),
    });
    expect(reviewFeed?.candidateId).toBeDefined();

    const candidate = await connection.db.query.releaseCandidates.findFirst({
      where: (table, { eq }) => eq(table.id, reviewFeed!.candidateId!),
    });
    expect(candidate?.matchedTrackId).toBeDefined();

    const resolution = await resolveFeedReview(connection.db, userId, reviewFeed!.id, "confirm");
    expect(resolution).toMatchObject({ decision: "confirm", removed: false, state: "new" });

    const persistedCandidate = await connection.db.query.releaseCandidates.findFirst({
      where: (table, { eq }) => eq(table.id, candidate!.id),
    });
    expect(persistedCandidate).toMatchObject({
      matchConfidence: "1.000",
      matchRule: "manual_confirmation",
      matchStatus: "matched",
    });
    expect(
      (await connection.db.select().from(manualMatchDecisions)).filter(
        (decision) => decision.candidateId === candidate!.id,
      ),
    ).toHaveLength(1);
    const resolvedFeed = (await connection.db.select().from(feedItems)).find(
      (item) => item.id === reviewFeed!.id,
    );
    expect(typeof resolvedFeed?.appearanceId).toBe("string");
    expect(resolvedFeed?.state).toBe("new");
    expect(
      (await connection.db.select().from(trackExternalIds)).some(
        (externalId) =>
          externalId.provider === candidate!.provider &&
          externalId.externalId === candidate!.providerTrackId &&
          externalId.trackId === candidate!.matchedTrackId,
      ),
    ).toBe(true);
  });
});
