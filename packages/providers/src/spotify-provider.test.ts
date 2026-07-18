import { describe, expect, it, vi } from "vitest";
import { SpotifyProvider } from "./spotify-provider";
import type { SpotifyAlbum, SpotifyAlbumSummary, SpotifyClient } from "./spotify";

describe("SpotifyProvider incremental scanning", () => {
  it("reports one persisted batch for every mapped artist, including empty results", async () => {
    const getArtistAlbumsBounded = vi
      .fn()
      .mockResolvedValue({ items: [], pagesScanned: 1, partial: false });
    const client = {
      getArtistAlbumsBounded,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [
        { artistId: "artist-1", name: "First Artist", spotifyArtistId: "spotify-1" },
        { artistId: "artist-2", name: "Second Artist", spotifyArtistId: "spotify-2" },
      ],
    });

    const result = await provider.scan({
      filter: { provider: "spotify" },
      onBatch,
    });

    expect(result.candidates).toEqual([]);
    expect(getArtistAlbumsBounded).toHaveBeenCalledTimes(2);
    expect(onBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        candidates: [],
        completedUnits: 1,
        currentUnit: "First Artist",
        totalUnits: 2,
      }),
    );
    expect(onBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        candidates: [],
        completedUnits: 2,
        currentUnit: "Second Artist",
        totalUnits: 2,
      }),
    );
  });

  it("stops before the next artist after cancellation", async () => {
    const controller = new AbortController();
    const getArtistAlbumsBounded = vi.fn().mockImplementation(() => {
      controller.abort(new Error("cancelled"));
      return Promise.resolve({ items: [], pagesScanned: 1, partial: false });
    });
    const client = {
      getArtistAlbumsBounded,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 1 },
    } as unknown as SpotifyClient;
    const provider = new SpotifyProvider({
      client,
      mappings: [
        { artistId: "artist-1", name: "First Artist", spotifyArtistId: "spotify-1" },
        { artistId: "artist-2", name: "Second Artist", spotifyArtistId: "spotify-2" },
      ],
    });

    await expect(
      provider.scan({ filter: { provider: "spotify" }, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(getArtistAlbumsBounded).toHaveBeenCalledOnce();
  });

  it("reports page releases and backfill decisions without fetching rejected details", async () => {
    const eligible = albumSummary("eligible", "July Release", "2026-07-16");
    const old = albumSummary("old", "Old Release", "2025-01-01");
    const getAlbum = vi.fn().mockResolvedValue(albumWithTrack(eligible));
    const client = {
      getAlbum,
      getArtistAlbumsBounded: vi
        .fn()
        .mockResolvedValue({ items: [eligible, old], pagesScanned: 1, partial: true }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
    });

    await provider.scan({
      filter: { provider: "spotify", since: "2026-05-19" },
      onBatch,
    });

    expect(getAlbum).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        releases: [
          expect.objectContaining({
            backfillEligible: true,
            candidateCount: 1,
            releaseDate: "2026-07-16",
            selectedForDetails: true,
            title: "July Release",
          }),
          expect.objectContaining({
            backfillEligible: false,
            candidateCount: 0,
            releaseDate: "2025-01-01",
            selectedForDetails: false,
            title: "Old Release",
          }),
        ],
      }),
    );
  });
});

function albumSummary(id: string, name: string, releaseDate: string): SpotifyAlbumSummary {
  return {
    album_type: "single",
    artists: [spotifyArtist],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
    id,
    name,
    release_date: releaseDate,
    release_date_precision: "day",
    total_tracks: 1,
    type: "album",
    uri: `spotify:album:${id}`,
  };
}

function albumWithTrack(summary: SpotifyAlbumSummary): SpotifyAlbum {
  return {
    ...summary,
    tracks: {
      href: `https://api.spotify.com/v1/albums/${summary.id}/tracks`,
      items: [
        {
          artists: [spotifyArtist],
          disc_number: 1,
          duration_ms: 180_000,
          explicit: false,
          external_urls: { spotify: "https://open.spotify.com/track/track-1" },
          id: "track-1",
          is_local: false,
          is_playable: true,
          name: "July Track",
          track_number: 1,
          type: "track",
          uri: "spotify:track:track-1",
        },
      ],
      limit: 50,
      next: null,
      offset: 0,
      previous: null,
      total: 1,
    },
  };
}

const spotifyArtist = {
  external_urls: { spotify: "https://open.spotify.com/artist/spotify-yussi" },
  id: "spotify-yussi",
  name: "YUSSI",
  type: "artist" as const,
  uri: "spotify:artist:spotify-yussi",
};
