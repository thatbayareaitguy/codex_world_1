import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  createOrResumeDiscoveryReconciliationCampaign,
  finishDiscoveryReconciliationCampaign,
  loadCampaignIdentities,
  recordCampaignAppleBatch,
  recordCampaignPlaylistPreview,
  recordCampaignSpotifyBatch,
  reconcileCampaignProviderReleases,
  selectNextSpotifyReconciliationCohort,
} from "./discovery-reconciliation";
import {
  artistExternalIds,
  artistFollows,
  artists,
  appleMusicArtistScans,
  appleMusicScanBatches,
  discoveryReconciliationArtists,
  discoveryReconciliationCampaigns,
  releaseCandidates,
  releaseExternalIds,
  releaseProviderReconciliations,
  releases,
  spotifyArtistScans,
  spotifyRequestEvents,
  spotifyScanBatches,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Apple-first discovery reconciliation campaigns", () => {
  const connection = createDatabase(databaseUrl);
  const userId = randomUUID();
  const artistIds = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.db.insert(users).values({
      displayName: "Reconciliation Test User",
      email: "reconciliation@example.test",
      id: userId,
    });
    await connection.db.insert(artists).values(
      artistIds.map((id, index) => ({
        id,
        name: `Campaign Artist ${index + 1}`,
        normalizedName: `campaign artist ${index + 1}`,
      })),
    );
    await connection.db
      .insert(artistFollows)
      .values(artistIds.map((artistId) => ({ artistId, source: "test", userId })));
    await connection.db.insert(artistExternalIds).values(
      artistIds.flatMap((artistId, index) => [
        {
          artistId,
          confirmed: true,
          externalId: `apple-${index + 1}`,
          provider: "apple_music" as const,
          providerUrl: `https://music.apple.com/us/artist/${index + 1}`,
        },
        {
          artistId,
          confirmed: true,
          externalId: `spotify-${index + 1}`,
          provider: "spotify" as const,
          providerUrl: `https://open.spotify.com/artist/${index + 1}`,
        },
      ]),
    );
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("creates and resumes one durable campaign with a prioritized rotating cohort", async () => {
    const created = await createOrResumeDiscoveryReconciliationCampaign(
      connection.db,
      { spotifyCohortSize: 2, spotifyPageLimit: 1, spotifyRotationSize: 1, windowDays: 30 },
      new Date("2026-08-06T12:00:00Z"),
    );
    expect(created.created).toBe(true);
    expect(created.identities).toHaveLength(3);
    await connection.db
      .update(discoveryReconciliationArtists)
      .set({ appleRecentDiscovery: true, latestAppleReleaseDate: "2026-08-05" })
      .where(
        and(
          eq(discoveryReconciliationArtists.campaignId, created.campaignId),
          eq(discoveryReconciliationArtists.artistId, artistIds[1]!),
        ),
      );

    const cohort = await selectNextSpotifyReconciliationCohort(connection.db, created.campaignId);
    expect(cohort.map((identity) => identity.artistId)).toEqual([artistIds[1], artistIds[0]]);

    const resumed = await createOrResumeDiscoveryReconciliationCampaign(
      connection.db,
      { spotifyCohortSize: 2, spotifyPageLimit: 1, spotifyRotationSize: 1, windowDays: 30 },
      new Date("2026-08-06T13:00:00Z"),
    );
    expect(resumed).toMatchObject({ campaignId: created.campaignId, created: false });

    await connection.db
      .update(artistExternalIds)
      .set({ externalId: "spotify-mapping-changed" })
      .where(
        and(
          eq(artistExternalIds.artistId, artistIds[0]!),
          eq(artistExternalIds.provider, "spotify"),
        ),
      );
    expect(await loadCampaignIdentities(connection.db, created.campaignId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artistId: artistIds[0], spotifyArtistId: "spotify-1" }),
      ]),
    );
  });

  it("keeps Apple discovery active until the persisted batch has no unfinished artists", async () => {
    const campaign = await connection.db.query.discoveryReconciliationCampaigns.findFirst();
    expect(campaign).toBeDefined();
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({ requestCount: 4, status: "partial", totalArtists: 3 })
      .returning({ id: appleMusicScanBatches.id });
    expect(batch).toBeDefined();
    await connection.db.insert(appleMusicArtistScans).values(
      artistIds.map((artistId, position) => ({
        artistId,
        batchId: batch!.id,
        position,
        providerArtistId: `apple-${position + 1}`,
        status: position === 0 ? ("completed" as const) : ("pending" as const),
        windowEnd: "2026-08-06",
        windowStart: "2026-07-07",
      })),
    );

    await recordCampaignAppleBatch(connection.db, campaign!.id, batch!.id);
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
      }),
    ).toMatchObject({ appleArtistsScanned: 1, stage: "apple_discovery", status: "paused" });

    await connection.db
      .update(appleMusicArtistScans)
      .set({ status: "completed" })
      .where(eq(appleMusicArtistScans.batchId, batch!.id));
    await recordCampaignAppleBatch(connection.db, campaign!.id, batch!.id);
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
      }),
    ).toMatchObject({
      appleArtistsScanned: 3,
      appleRequestCount: 4,
      stage: "spotify_reconciliation",
      status: "running",
    });
  });

  it("records Spotify progress and request counts idempotently", async () => {
    const campaign = await connection.db.query.discoveryReconciliationCampaigns.findFirst();
    expect(campaign).toBeDefined();
    const [batch] = await connection.db
      .insert(spotifyScanBatches)
      .values({ mode: "daily", pageLimit: 1, totalArtists: 2 })
      .returning({ id: spotifyScanBatches.id });
    expect(batch).toBeDefined();
    await connection.db.insert(spotifyArtistScans).values([
      {
        artistId: artistIds[0]!,
        batchId: batch!.id,
        candidateCount: 2,
        pagesScanned: 1,
        position: 0,
        providerArtistId: "spotify-1",
        releaseCount: 2,
        requestCount: 2,
        status: "completed",
      },
      {
        artistId: artistIds[1]!,
        batchId: batch!.id,
        candidateCount: 1,
        pagesScanned: 1,
        position: 1,
        providerArtistId: "spotify-2",
        releaseCount: 1,
        requestCount: 1,
        status: "partial",
      },
    ]);
    await connection.db.insert(spotifyRequestEvents).values(
      [0, 1, 2].map((index) => ({
        discoveryReconciliationCampaignId: campaign!.id,
        endpointCategory: "artist_albums",
        method: "GET",
        startedAt: new Date(`2026-08-06T12:00:0${index}Z`),
        status: 200,
      })),
    );

    const first = await recordCampaignSpotifyBatch(connection.db, campaign!.id, batch!.id);
    const repeated = await recordCampaignSpotifyBatch(connection.db, campaign!.id, batch!.id);

    expect(first.reconciliableArtistIds).toEqual([artistIds[0], artistIds[1]]);
    expect(repeated).toEqual(first);
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
      }),
    ).toMatchObject({ spotifyArtistsScanned: 2, spotifyRequestCount: 3 });
  });

  it("persists idempotent internal release reconciliation evidence", async () => {
    const campaign = await connection.db.query.discoveryReconciliationCampaigns.findFirst();
    expect(campaign).toBeDefined();
    const [release] = await connection.db
      .insert(releases)
      .values({
        normalizedTitle: "shared release",
        releaseDate: "2026-08-05",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: "Shared Release",
      })
      .returning({ id: releases.id });
    expect(release).toBeDefined();
    await connection.db.insert(releaseExternalIds).values([
      {
        externalId: "apple-release",
        provider: "apple_music",
        providerUrl: "https://music.apple.com/us/album/1",
        releaseId: release!.id,
      },
      {
        externalId: "spotify-release",
        provider: "spotify",
        providerUrl: "https://open.spotify.com/album/1",
        releaseId: release!.id,
      },
    ]);
    await connection.db
      .insert(releaseCandidates)
      .values([
        candidate("apple_music", "apple-1", "apple-release", "apple-track"),
        candidate("spotify", "spotify-1", "spotify-release", "spotify-track"),
      ]);

    await reconcileCampaignProviderReleases(connection.db, campaign!.id, [artistIds[0]!]);
    await reconcileCampaignProviderReleases(connection.db, campaign!.id, [artistIds[0]!]);

    const rows = await connection.db
      .select()
      .from(releaseProviderReconciliations)
      .where(eq(releaseProviderReconciliations.campaignId, campaign!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appleProviderReleaseId: "apple-release",
      playlistEligibleTrackCount: 1,
      spotifyProviderReleaseId: "spotify-release",
      status: "matched",
    });
  });

  it("defers the playlist preview until all Spotify campaign artists are terminal", async () => {
    const campaign = await connection.db.query.discoveryReconciliationCampaigns.findFirst();
    expect(campaign).toBeDefined();

    await finishDiscoveryReconciliationCampaign(connection.db, campaign!.id);
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
      }),
    ).toMatchObject({ completedAt: null, stage: "spotify_reconciliation", status: "paused" });

    await connection.db
      .update(discoveryReconciliationArtists)
      .set({ spotifyStatus: "completed" })
      .where(eq(discoveryReconciliationArtists.campaignId, campaign!.id));
    await finishDiscoveryReconciliationCampaign(connection.db, campaign!.id);
    expect(
      await connection.db.query.discoveryReconciliationCampaigns.findFirst({
        where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
      }),
    ).toMatchObject({ completedAt: null, stage: "playlist_preview", status: "running" });

    await recordCampaignPlaylistPreview(connection.db, campaign!.id, { additions: 0 });
    const completed = await connection.db.query.discoveryReconciliationCampaigns.findFirst({
      where: eq(discoveryReconciliationCampaigns.id, campaign!.id),
    });
    expect(completed).toMatchObject({
      playlistPreview: { additions: 0 },
      stage: "completed",
      status: "completed",
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
  });
});

function candidate(
  provider: "apple_music" | "spotify",
  artistExternalId: string,
  providerReleaseId: string,
  providerTrackId: string,
) {
  return {
    artistExternalId,
    firstSeenAt: new Date("2026-08-06T12:00:00Z"),
    matchConfidence: "1.000",
    matchReasons: ["test"],
    matchRule: "new_canonical",
    matchStatus: "new" as const,
    normalizedTitle: "shared track",
    payloadHash: `${provider}-hash`,
    provider,
    providerReleaseId,
    providerTrackId,
    rawPayload: {
      discNumber: 1,
      releaseTitle: "Shared Release",
      releaseType: "single",
      title: "Shared Track",
      trackNumber: 1,
    },
    releaseDate: "2026-08-05",
    title: "Shared Track",
  };
}
