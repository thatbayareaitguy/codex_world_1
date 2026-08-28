import {
  artistExternalIds,
  artists,
  createDatabase,
  discoveryReconciliationCampaigns,
  releaseCandidates,
  releaseExternalIds,
  releaseProviderReconciliations,
  releases,
} from "@radar/db";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildShowcasePublicCatalog, loadShowcasePublicationSource } from "./showcase-publication";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Showcase persisted-data publication source", () => {
  const connection = createDatabase(databaseUrl);
  const artistId = randomUUID();
  const matchedAppleReleaseId = randomUUID();
  const appleOnlyReleaseId = randomUUID();
  const spotifyOnlyReleaseId = randomUUID();

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.db.insert(artists).values({
      id: artistId,
      name: "Persisted Artist",
      normalizedName: "persisted artist",
    });
    await connection.db.insert(artistExternalIds).values({
      artistId,
      confirmed: true,
      externalId: "apple-artist-1",
      provider: "apple_music",
      providerUrl: "https://music.apple.com/us/artist/persisted-artist/1",
    });
    await connection.db.insert(releases).values([
      {
        id: matchedAppleReleaseId,
        normalizedTitle: "matched apple release",
        releaseDate: "2026-08-20",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: "Matched Apple Release",
      },
      {
        id: appleOnlyReleaseId,
        normalizedTitle: "apple only release",
        releaseDate: "2026-09-05",
        releaseDatePrecision: "day",
        releaseType: "album",
        title: "Apple Only Release",
      },
      {
        id: spotifyOnlyReleaseId,
        normalizedTitle: "spotify only release",
        releaseDate: "2026-08-18",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: "Spotify Only Release",
      },
    ]);
    await connection.db.insert(releaseExternalIds).values([
      {
        externalId: "apple-release-matched",
        provider: "apple_music",
        providerUrl: "https://music.apple.com/us/album/matched-apple-release/101",
        releaseId: matchedAppleReleaseId,
      },
      {
        externalId: "apple-release-only",
        provider: "apple_music",
        providerUrl: "https://music.apple.com/us/album/apple-only-release/102",
        releaseId: appleOnlyReleaseId,
      },
      {
        externalId: "spotify-release-matched",
        provider: "spotify",
        providerUrl: "https://open.spotify.com/album/spotify-release-matched",
        releaseId: matchedAppleReleaseId,
      },
      {
        externalId: "spotify-release-only",
        provider: "spotify",
        providerUrl: "https://open.spotify.com/album/spotify-release-only",
        releaseId: spotifyOnlyReleaseId,
      },
    ]);
    const candidateValues: (typeof releaseCandidates.$inferInsert)[] = [
      {
        artistExternalId: "apple-artist-1",
        firstSeenAt: new Date("2026-08-21T12:00:00Z"),
        matchConfidence: "1.000",
        matchReasons: ["synthetic Apple fixture"],
        matchRule: "fixture",
        matchStatus: "matched",
        normalizedTitle: "matched apple release",
        payloadHash: "apple-candidate-matched",
        provider: "apple_music",
        providerReleaseId: "apple-release-matched",
        providerTrackId: "apple-track-matched",
        rawPayload: {
          privateScannerField: "must-not-publish",
          releaseTitle: "Matched Apple Release",
          releaseType: "single",
        },
        releaseDate: "2026-08-20",
        title: "Matched Apple Release",
      },
      {
        artistExternalId: "apple-artist-1",
        firstSeenAt: new Date("2026-08-22T12:00:00Z"),
        matchConfidence: "1.000",
        matchReasons: ["synthetic Apple fixture"],
        matchRule: "fixture",
        matchStatus: "matched",
        normalizedTitle: "apple only release",
        payloadHash: "apple-candidate-only",
        provider: "apple_music",
        providerReleaseId: "apple-release-only",
        providerTrackId: "apple-track-only",
        rawPayload: {
          privateScannerField: "must-not-publish",
          releaseTitle: "Apple Only Release",
          releaseType: "album",
        },
        releaseDate: "2026-09-05",
        title: "Apple Only Release",
      },
      {
        artistExternalId: "spotify-artist-1",
        firstSeenAt: new Date("2026-08-19T12:00:00Z"),
        matchConfidence: "1.000",
        matchReasons: ["synthetic Spotify fixture"],
        matchRule: "fixture",
        matchStatus: "matched",
        normalizedTitle: "spotify only release",
        payloadHash: "spotify-candidate-only",
        provider: "spotify",
        providerReleaseId: "spotify-release-only",
        providerTrackId: "spotify-track-only",
        rawPayload: {
          privateScannerField: "must-not-publish",
          releaseTitle: "Spotify Only Release",
          releaseType: "single",
        },
        releaseDate: "2026-08-18",
        title: "Spotify Only Release",
      },
    ];
    await connection.db.insert(releaseCandidates).values(candidateValues);
    const campaignId = randomUUID();
    await connection.db.insert(discoveryReconciliationCampaigns).values({
      campaignKey: `showcase-publication-${campaignId}`,
      effectiveConfiguration: {},
      id: campaignId,
      spotifyCohortSize: 1,
      spotifyPageLimit: 1,
      spotifyRotationSize: 0,
      totalArtists: 1,
      windowEnd: "2026-08-27",
      windowStart: "2026-07-28",
    });
    await connection.db.insert(releaseProviderReconciliations).values({
      appleCanonicalReleaseId: matchedAppleReleaseId,
      appleProviderReleaseId: "apple-release-matched",
      artistId,
      campaignId,
      confidence: "1.000",
      reconciliationKey: "matched-apple-release",
      releaseDate: "2026-08-20",
      releaseType: "single",
      reasons: ["strict synthetic title and date match"],
      spotifyCanonicalReleaseId: matchedAppleReleaseId,
      spotifyProviderReleaseId: "spotify-release-matched",
      status: "matched",
      title: "Matched Apple Release",
    });
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("exports Apple-origin releases, includes confirmed Spotify, and excludes Spotify-only", async () => {
    const source = await loadShowcasePublicationSource(connection.db);
    const result = buildShowcasePublicCatalog(source, new Date("2026-08-27T12:00:00Z"));

    expect(result).toMatchObject({
      invalidAppleReleaseCount: 0,
      releaseCount: 2,
      withSpotifyCount: 1,
      withoutSpotifyCount: 1,
    });
    expect(result.catalog.releases.map((release) => release.title)).toEqual([
      "Apple Only Release",
      "Matched Apple Release",
    ]);
    expect(
      result.catalog.releases.find((release) => release.title === "Matched Apple Release")?.links,
    ).toEqual({
      appleMusic: "https://music.apple.com/us/album/matched-apple-release/101",
      spotify: "https://open.spotify.com/album/spotify-release-matched",
    });
    expect(JSON.stringify(result.catalog)).not.toContain("privateScannerField");
    expect(JSON.stringify(result.catalog)).not.toContain(matchedAppleReleaseId);
  });
});
