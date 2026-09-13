import type { TrackCandidate } from "@radar/core";
import {
  createDatabase,
  createSpotifyArtworkBackfillRepository,
  feedItems,
  releaseExternalIds,
  releases,
  tracks,
} from "@radar/db";
import type { SpotifyAlbum } from "@radar/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { persistCandidates } from "./scan";
import { runSpotifyArtworkBackfill } from "./spotify-artwork-backfill";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Spotify artwork backfill persistence", () => {
  const connection = createDatabase(databaseUrl);
  const spotifyAlbumId = "1".padEnd(22, "A");

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await persistCandidates(connection.db, [candidate(spotifyAlbumId)], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("writes only namespaced artwork, refreshes the feed, and reruns idempotently", async () => {
    const before = {
      feed: (await connection.db.select().from(feedItems)).length,
      releases: (await connection.db.select().from(releases)).length,
      tracks: (await connection.db.select().from(tracks)).length,
    };
    const feedBefore = (await connection.db.select().from(feedItems))[0];
    const getAlbum = vi.fn(() => Promise.resolve(album(spotifyAlbumId)));
    const client = {
      getAlbum,
      metrics: {
        get queueWaitMs() {
          return 0;
        },
        get requests() {
          return getAlbum.mock.calls.length;
        },
      },
    };

    const first = await runSpotifyArtworkBackfill(
      { apply: true, limit: 1, resume: false },
      { client, repository: createSpotifyArtworkBackfillRepository(connection.db) },
    );
    expect(first).toMatchObject({ processed: 1, remaining: 0, updated: 1 });
    const external = (await connection.db.select().from(releaseExternalIds))[0];
    expect(external?.providerFields).toMatchObject({
      artworkBackfill: { status: "updated" },
      spotify: {
        albumId: spotifyAlbumId,
        image: { url: "https://i.scdn.co/image/integrationart" },
        sourceProvider: "spotify",
      },
    });
    const feedAfter = (await connection.db.select().from(feedItems))[0];
    expect(feedAfter?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      feedBefore?.updatedAt.getTime() ?? 0,
    );
    expect((await connection.db.select().from(releases)).length).toBe(before.releases);
    expect((await connection.db.select().from(tracks)).length).toBe(before.tracks);
    expect((await connection.db.select().from(feedItems)).length).toBe(before.feed);

    const second = await runSpotifyArtworkBackfill(
      { apply: true, limit: 1, resume: false },
      { client, repository: createSpotifyArtworkBackfillRepository(connection.db) },
    );
    expect(second).toMatchObject({ processed: 0, remaining: 0, updated: 0 });
    expect(getAlbum).toHaveBeenCalledOnce();
  });
});

function candidate(externalReleaseId: string): TrackCandidate {
  return {
    artistExternalId: "spotify-backfill-artist",
    artistName: "Backfill Artist",
    availability: "playable",
    credits: [{ name: "Backfill Artist", role: "primary" }],
    durationMs: 180_000,
    evidenceType: "spotify_track",
    evidenceUrl: "https://open.spotify.com/track/backfill-track",
    externalReleaseId,
    externalTrackId: "backfill-track",
    firstSeenAt: "2026-07-21T12:00:00.000Z",
    payloadHash: "spotify-backfill-track",
    provider: "spotify",
    providerUrl: "https://open.spotify.com/track/backfill-track",
    region: "US",
    releaseDate: "2026-07-21",
    releaseDatePrecision: "day",
    releaseTitle: "Backfill Release",
    releaseType: "single",
    sourceLabel: "Spotify test",
    title: "Backfill Track",
  };
}

function album(id: string): SpotifyAlbum {
  return {
    album_type: "single",
    artists: [],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
    id,
    images: [{ height: 300, url: "https://i.scdn.co/image/integrationart", width: 300 }],
    name: "Backfill Release",
    release_date: "2026-07-21",
    release_date_precision: "day",
    total_tracks: 0,
    tracks: {
      href: "https://api.spotify.com/v1/albums/test/tracks",
      items: [],
      limit: 50,
      next: null,
      total: 0,
    },
    type: "album",
    uri: `spotify:album:${id}`,
  };
}
