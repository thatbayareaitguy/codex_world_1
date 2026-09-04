import type { TrackCandidate } from "@radar/core";
import { createDatabase, feedItems, releaseExternalIds, sourceEvidence } from "@radar/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistCandidates } from "../../scanner/src/scan";
import { loadDatabaseFeedSnapshot } from "./feed-server";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const spotifyAlbumId = "0123456789ABCDEFGHIJKL";
const spotifyTrackOneId = "1123456789ABCDEFGHIJKL";
const spotifyTrackTwoId = "2123456789ABCDEFGHIJKL";

describe.sequential("Spotify release artwork persistence", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("persists one namespaced artwork record for an album and exposes it to the feed", async () => {
    const candidates = [
      spotifyCandidate(spotifyTrackOneId, "First Track"),
      spotifyCandidate(spotifyTrackTwoId, "Second Track"),
    ];

    await persistCandidates(connection.db, candidates, {
      dryRun: false,
      full: false,
      provider: "spotify",
    });

    const externalIds = (await connection.db.select().from(releaseExternalIds)).filter(
      (row) => row.externalId === spotifyAlbumId && row.provider === "spotify",
    );
    expect(externalIds).toHaveLength(1);
    expect(externalIds[0]).toMatchObject({
      externalId: spotifyAlbumId,
      provider: "spotify",
      providerUrl: `https://open.spotify.com/album/${spotifyAlbumId}`,
    });
    expect(externalIds[0]?.providerFields).toMatchObject({
      spotify: {
        albumId: spotifyAlbumId,
        image: { height: 300, url: "https://i.scdn.co/image/artworkone", width: 300 },
        sourceProvider: "spotify",
      },
    });
    expect(JSON.stringify(externalIds[0]?.providerFields)).not.toContain("data:");

    const snapshot = await loadDatabaseFeedSnapshot(databaseUrl);
    const albumItems = snapshot.items.filter((item) => item.releaseTitle === "Artwork Album");
    expect(albumItems).toHaveLength(2);
    expect(
      albumItems.every(
        (item) => item.spotifyArtwork?.image.url === "https://i.scdn.co/image/artworkone",
      ),
    ).toBe(true);
  });

  it("updates changed artwork idempotently without duplicating feed or evidence records", async () => {
    const beforeFeedCount = (await connection.db.select().from(feedItems)).length;
    const beforeEvidenceCount = (await connection.db.select().from(sourceEvidence)).length;
    const changed = spotifyCandidate(spotifyTrackOneId, "First Track");
    changed.spotifyRelease = {
      ...changed.spotifyRelease!,
      image: { height: 640, url: "https://i.scdn.co/image/artworktwo", width: 640 },
      lastObservedAt: "2026-07-20T13:00:00.000Z",
    };

    const result = await persistCandidates(connection.db, [changed], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });

    expect(result).toMatchObject({ inserted: 0, skipped: 1 });
    expect(
      (await connection.db.select().from(releaseExternalIds)).filter(
        (row) => row.externalId === spotifyAlbumId && row.provider === "spotify",
      ),
    ).toHaveLength(1);
    expect((await connection.db.select().from(feedItems)).length).toBe(beforeFeedCount);
    expect((await connection.db.select().from(sourceEvidence)).length).toBe(beforeEvidenceCount);
    const snapshot = await loadDatabaseFeedSnapshot(databaseUrl);
    expect(
      snapshot.items
        .filter((item) => item.releaseTitle === "Artwork Album")
        .every((item) => item.spotifyArtwork?.image.url === "https://i.scdn.co/image/artworktwo"),
    ).toBe(true);
  });

  it("keeps missing, unsafe, and non-Spotify artwork off the feed", async () => {
    const missing = spotifyCandidate(
      "3123456789ABCDEFGHIJKL",
      "Missing Art",
      "4123456789ABCDEFGHIJKL",
    );
    delete missing.spotifyRelease;
    const unsafe = spotifyCandidate(
      "5123456789ABCDEFGHIJKL",
      "Unsafe Art",
      "6123456789ABCDEFGHIJKL",
    );
    unsafe.spotifyRelease = {
      ...unsafe.spotifyRelease!,
      albumId: "6123456789ABCDEFGHIJKL",
      albumUrl: "https://open.spotify.com/album/6123456789ABCDEFGHIJKL",
      image: { height: 300, url: "https://example.com/unsafe.jpg", width: 300 },
    };
    const musicbrainzBase = spotifyCandidate("mb-track", "MusicBrainz Only", "mb-release");
    delete musicbrainzBase.spotifyRelease;
    const musicbrainz: TrackCandidate = {
      ...musicbrainzBase,
      artistExternalId: "00000000-0000-4000-8000-000000000111",
      evidenceType: "musicbrainz_recording",
      evidenceUrl: "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000112",
      externalReleaseId: "00000000-0000-4000-8000-000000000113",
      externalTrackId: "00000000-0000-4000-8000-000000000112",
      payloadHash: "mb-artwork-test",
      provider: "musicbrainz",
      providerUrl: "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000112",
      sourceLabel: "MusicBrainz test",
    };

    await persistCandidates(connection.db, [missing, unsafe], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
    await persistCandidates(connection.db, [musicbrainz], {
      dryRun: false,
      full: false,
      provider: "musicbrainz",
    });

    const snapshot = await loadDatabaseFeedSnapshot(databaseUrl);
    for (const title of ["Missing Art", "Unsafe Art", "MusicBrainz Only"]) {
      expect(snapshot.items.find((item) => item.title === title)?.spotifyArtwork).toBeUndefined();
    }
  });
});

function spotifyCandidate(
  externalTrackId: string,
  title: string,
  externalReleaseId = spotifyAlbumId,
): TrackCandidate {
  const albumUrl = `https://open.spotify.com/album/${externalReleaseId}`;
  return {
    artistExternalId: "spotify-artwork-artist",
    artistName: "Artwork Artist",
    availability: "playable",
    credits: [{ name: "Artwork Artist", role: "primary" }],
    durationMs: 180_000,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/${externalTrackId}`,
    externalReleaseId,
    externalTrackId,
    firstSeenAt: "2026-07-20T12:00:00.000Z",
    payloadHash: `artwork-${externalTrackId}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/${externalTrackId}`,
    region: "US",
    releaseDate: "2026-07-20",
    releaseDatePrecision: "day",
    releaseTitle: externalReleaseId === spotifyAlbumId ? "Artwork Album" : title,
    releaseType: externalReleaseId === spotifyAlbumId ? "album" : "single",
    sourceLabel: "Spotify test",
    spotifyRelease: {
      albumId: externalReleaseId,
      albumUrl,
      image: { height: 300, url: "https://i.scdn.co/image/artworkone", width: 300 },
      lastObservedAt: "2026-07-20T12:00:00.000Z",
      sourceProvider: "spotify",
    },
    title,
  };
}
