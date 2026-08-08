import { describe, expect, it, vi } from "vitest";
import type { ProviderReleaseTrackPage, ProviderScanPage } from "./contracts";
import { SpotifyProvider } from "./spotify-provider";
import type { SpotifyAlbum, SpotifyAlbumSummary, SpotifyClient } from "./spotify";

describe("SpotifyProvider incremental scanning", () => {
  it("reports one persisted batch for every mapped artist, including empty results", async () => {
    const getArtistAlbumsPage = vi
      .fn()
      .mockResolvedValue({ items: [], nextOffset: null, offset: 0, total: 0 });
    const client = {
      getArtistAlbumsPage,
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
    expect(getArtistAlbumsPage).toHaveBeenCalledTimes(2);
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
    const getArtistAlbumsPage = vi.fn().mockImplementation(() => {
      controller.abort(new Error("cancelled"));
      return Promise.resolve({ items: [], nextOffset: null, offset: 0, total: 0 });
    });
    const client = {
      getArtistAlbumsPage,
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
    expect(getArtistAlbumsPage).toHaveBeenCalledOnce();
  });

  it("reports page releases and backfill decisions without fetching rejected details", async () => {
    const eligible = albumSummary("eligible", "July Release", "2026-07-16");
    const old = albumSummary("old", "Old Release", "2025-01-01");
    const getAlbum = vi.fn().mockResolvedValue(albumWithTrack(eligible));
    const client = {
      getAlbum,
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [eligible, old], nextOffset: 2, offset: 0, total: 20 }),
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

  it("can defer eligible release details for scheduler work", async () => {
    const eligible = albumSummary("deferred", "Deferred Release", "2026-07-16");
    const getAlbum = vi.fn();
    const onPage = vi.fn().mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client: {
        getAlbum,
        getArtistAlbumsPage: vi
          .fn()
          .mockResolvedValue({ items: [eligible], nextOffset: null, offset: 0, total: 1 }),
        metrics: { failures: 0, rateLimitWaitMs: 0, requests: 1 },
      } as unknown as SpotifyClient,
      deferReleaseDetails: true,
      mappings: [{ artistId: "artist-1", name: "Artist", spotifyArtistId: "spotify-1" }],
    });

    await provider.scan({ filter: { provider: "spotify", since: "2026-05-19" }, onPage });

    expect(getAlbum).not.toHaveBeenCalled();
    expect(onPage).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [],
        releases: [expect.objectContaining({ selectedForDetails: true })],
      }),
    );
  });

  it("attaches the same validated Spotify album artwork to every track candidate", async () => {
    const summary = albumSummary("album-art", "Artwork Release", "2026-07-16");
    const album = albumWithTrack(summary);
    album.images = [
      { height: 640, url: "https://i.scdn.co/image/large", width: 640 },
      { height: 300, url: "https://i.scdn.co/image/medium", width: 300 },
    ];
    album.tracks.items.push({
      ...album.tracks.items[0]!,
      external_urls: { spotify: "https://open.spotify.com/track/track-2" },
      id: "track-2",
      name: "Second Track",
      track_number: 2,
      uri: "spotify:track:track-2",
    });
    const client = {
      getAlbum: vi.fn().mockResolvedValue(album),
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    });

    const result = await provider.scan({ filter: { provider: "spotify" } });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.spotifyRelease).toEqual({
      albumId: "album-art",
      albumUrl: "https://open.spotify.com/album/album-art",
      image: { height: 300, url: "https://i.scdn.co/image/medium", width: 300 },
      lastObservedAt: "2026-07-20T12:00:00.000Z",
      sourceProvider: "spotify",
    });
    expect(result.candidates[1]?.spotifyRelease).toEqual(result.candidates[0]?.spotifyRelease);
  });

  it("resumes at a later offset and discovers a recent release there", async () => {
    const recent = albumSummary("later-release", "Later Release", "2026-07-20");
    const getArtistAlbumsPage = vi.fn().mockResolvedValue({
      items: [recent],
      nextOffset: null,
      offset: 10,
      total: 11,
    });
    const client = {
      getAlbum: vi.fn().mockResolvedValue(albumWithTrack(recent)),
      getArtistAlbumsPage,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const onPage = vi.fn<(page: ProviderScanPage) => Promise<void>>().mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      startOffsets: new Map([["artist-1", 10]]),
    });

    const result = await provider.scan({
      filter: { provider: "spotify", since: "2026-05-22" },
      onPage,
    });

    expect(getArtistAlbumsPage).toHaveBeenCalledWith("spotify-yussi", 10, undefined);
    expect(result.candidates).toHaveLength(1);
    expect(onPage).toHaveBeenCalledWith(
      expect.objectContaining({ nextOffset: null, offset: 10, pageNumber: 2 }),
    );
  });

  it("fetches duplicate releases from multiple pages only once", async () => {
    const duplicate = albumSummary("duplicate-release", "Duplicate Release", "2026-07-20");
    const getArtistAlbumsPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [duplicate], nextOffset: 10, offset: 0, total: 2 })
      .mockResolvedValueOnce({ items: [duplicate], nextOffset: null, offset: 10, total: 2 });
    const getAlbum = vi.fn().mockResolvedValue(albumWithTrack(duplicate));
    const client = {
      getAlbum,
      getArtistAlbumsPage,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 3 },
    } as unknown as SpotifyClient;
    const onPage = vi.fn<(page: ProviderScanPage) => Promise<void>>().mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      maxPagesPerArtist: 2,
    });

    const result = await provider.scan({
      filter: { provider: "spotify", since: "2026-05-22" },
      onPage,
    });

    expect(result.candidates).toHaveLength(1);
    expect(getAlbum).toHaveBeenCalledTimes(1);
    const secondPage = onPage.mock.calls[1]?.[0];
    expect(secondPage?.candidates).toEqual([]);
    expect(secondPage?.releases[0]?.selectedForDetails).toBe(false);
    expect(secondPage?.releases[0]?.reasons).toContain(
      "Provider release ID already appeared earlier in this run",
    );
  });

  it("keeps an artist partial when its configured page limit leaves a next cursor", async () => {
    const getArtistAlbumsPage = vi.fn().mockResolvedValue({
      items: [],
      nextOffset: 10,
      offset: 0,
      total: 20,
    });
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const client = {
      getArtistAlbumsPage,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 1 },
    } as unknown as SpotifyClient;
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      maxPagesPerArtist: 1,
    });

    await provider.scan({ filter: { provider: "spotify" }, onBatch });

    expect(onBatch).toHaveBeenCalledWith(expect.objectContaining({ partial: true }));
  });

  it("uses one Artist Albums page and no detail or track calls for an unchanged known release", async () => {
    const summary = albumSummary("known-release", "Known Release", "2026-07-20");
    const getArtistAlbumsPage = vi
      .fn()
      .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 });
    const getAlbum = vi.fn();
    const getAlbumTracksPage = vi.fn();
    const client = {
      getAlbum,
      getAlbumTracksPage,
      getArtistAlbumsPage,
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 1 },
    } as unknown as SpotifyClient;
    const provider = new SpotifyProvider({
      client,
      knownReleaseIds: new Set([summary.id]),
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      maxPagesPerArtist: 1,
    });

    const result = await provider.scan({
      filter: { provider: "spotify", since: "2026-05-22" },
    });

    expect(result.providerMetrics.requests).toBe(1);
    expect(getArtistAlbumsPage).toHaveBeenCalledOnce();
    expect(getAlbum).not.toHaveBeenCalled();
    expect(getAlbumTracksPage).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
  });

  it("persists every page of a 25-track release before continuing", async () => {
    const summary = albumSummary("album-25", "Twenty Five", "2026-07-20");
    summary.total_tracks = 25;
    const album = albumWithTrack(summary);
    album.tracks.items = Array.from({ length: 20 }, (_, index) => spotifyTrack(index + 1));
    album.tracks.limit = 20;
    album.tracks.total = 25;
    album.tracks.next = "https://api.spotify.com/v1/albums/album-25/tracks?offset=20&limit=20";
    const persistedOffsets: number[] = [];
    const getAlbumTracksPage = vi.fn().mockImplementation(() => {
      expect(persistedOffsets).toEqual([0]);
      return Promise.resolve({
        items: Array.from({ length: 5 }, (_, index) => spotifyTrack(index + 21)),
        next: null,
        offset: 20,
        total: 25,
      });
    });
    const client = {
      getAlbum: vi.fn().mockResolvedValue(album),
      getAlbumTracksPage,
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 3 },
    } as unknown as SpotifyClient;
    const onReleaseTrackPage = vi.fn((page: ProviderReleaseTrackPage) => {
      persistedOffsets.push(page.offset);
      return Promise.resolve();
    });
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
    });

    const result = await provider.scan({
      filter: { provider: "spotify" },
      onReleaseTrackPage,
    });

    expect(result.candidates).toHaveLength(25);
    expect(persistedOffsets).toEqual([0, 20]);
    expect(onReleaseTrackPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ nextOffset: null, offset: 20, terminal: true }),
    );
    expect(getAlbumTracksPage).toHaveBeenCalledWith("album-25", 20, undefined);
  });

  it("resumes a partial release without replaying its completed first page", async () => {
    const summary = albumSummary("album-resume", "Resume Album", "2026-07-20");
    summary.total_tracks = 25;
    const album = albumWithTrack(summary);
    album.tracks.items = Array.from({ length: 20 }, (_, index) => spotifyTrack(index + 1));
    album.tracks.limit = 20;
    album.tracks.total = 25;
    album.tracks.next = "https://api.spotify.com/v1/albums/album-resume/tracks?offset=20&limit=20";
    const getAlbumTracksPage = vi.fn().mockResolvedValue({
      items: Array.from({ length: 5 }, (_, index) => spotifyTrack(index + 21)),
      next: null,
      offset: 20,
      total: 25,
    });
    const client = {
      getAlbum: vi.fn().mockResolvedValue(album),
      getAlbumTracksPage,
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const onReleaseTrackPage = vi.fn<(page: ProviderReleaseTrackPage) => Promise<void>>();
    onReleaseTrackPage.mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      incompleteReleaseIds: new Set([summary.id]),
      knownReleaseIds: new Set([summary.id]),
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      releaseTrackResume: new Map([[summary.id, { nextOffset: 20, status: "partial" }]]),
    });

    const result = await provider.scan({ filter: { provider: "spotify" }, onReleaseTrackPage });

    expect(result.candidates).toHaveLength(5);
    expect(onReleaseTrackPage).toHaveBeenCalledOnce();
    expect(onReleaseTrackPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }));
    expect(getAlbumTracksPage).toHaveBeenCalledOnce();
  });

  it("persists a fetched page but leaves the release incomplete for a malformed cursor", async () => {
    const summary = albumSummary("album-malformed", "Malformed Album", "2026-07-20");
    summary.total_tracks = 2;
    const album = albumWithTrack(summary);
    album.tracks.total = 2;
    album.tracks.next = "https://api.spotify.com/v1/albums/album-malformed/tracks?offset=nope";
    const client = {
      getAlbum: vi.fn().mockResolvedValue(album),
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 2 },
    } as unknown as SpotifyClient;
    const onReleaseTrackPage = vi.fn<(page: ProviderReleaseTrackPage) => Promise<void>>();
    onReleaseTrackPage.mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
    });

    await expect(
      provider.scan({ filter: { provider: "spotify" }, onReleaseTrackPage }),
    ).rejects.toThrow("malformed album track cursor");
    expect(onReleaseTrackPage).toHaveBeenCalledWith(
      expect.objectContaining({ errorClassification: "malformed_next_cursor", terminal: false }),
    );
  });

  it.each([
    ["SpotifyRequestBudgetError", "paused", "request_budget_exhausted"],
    ["SpotifyHttpError", "rate_limited", "rate_limited"],
  ] as const)(
    "preserves the next album cursor when %s interrupts the next page",
    async (errorName, status, classification) => {
      const summary = albumSummary(`album-${errorName}`, "Interrupted Album", "2026-07-20");
      summary.total_tracks = 2;
      const album = albumWithTrack(summary);
      album.tracks.total = 2;
      album.tracks.next = `https://api.spotify.com/v1/albums/${summary.id}/tracks?offset=1&limit=50`;
      const error = Object.assign(new Error(errorName), {
        name: errorName,
        ...(errorName === "SpotifyHttpError" ? { status: 429 } : {}),
      });
      const client = {
        getAlbum: vi.fn().mockResolvedValue(album),
        getAlbumTracksPage: vi.fn().mockRejectedValue(error),
        getArtistAlbumsPage: vi
          .fn()
          .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
        metrics: { failures: 1, rateLimitWaitMs: 0, requests: 3 },
      } as unknown as SpotifyClient;
      const onReleaseTrackError = vi.fn().mockResolvedValue(undefined);
      const onReleaseTrackPage = vi.fn().mockResolvedValue(undefined);
      const provider = new SpotifyProvider({
        client,
        mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
      });

      await expect(
        provider.scan({
          filter: { provider: "spotify" },
          onReleaseTrackError,
          onReleaseTrackPage,
        }),
      ).rejects.toThrow(errorName);
      expect(onReleaseTrackPage).toHaveBeenCalledWith(
        expect.objectContaining({ nextOffset: 1, offset: 0, terminal: false }),
      );
      expect(onReleaseTrackError).toHaveBeenCalledWith(
        expect.objectContaining({ classification, status }),
      );
    },
  );

  it("does not treat a short intermediate album page as complete", async () => {
    const summary = albumSummary("album-short", "Short Page Album", "2026-07-20");
    summary.total_tracks = 2;
    const album = albumWithTrack(summary);
    album.tracks.limit = 50;
    album.tracks.total = 2;
    album.tracks.next = "https://api.spotify.com/v1/albums/album-short/tracks?offset=50&limit=50";
    const client = {
      getAlbum: vi.fn().mockResolvedValue(album),
      getAlbumTracksPage: vi.fn().mockResolvedValue({
        items: [spotifyTrack(2)],
        next: null,
        offset: 50,
        total: 2,
      }),
      getArtistAlbumsPage: vi
        .fn()
        .mockResolvedValue({ items: [summary], nextOffset: null, offset: 0, total: 1 }),
      metrics: { failures: 0, rateLimitWaitMs: 0, requests: 3 },
    } as unknown as SpotifyClient;
    const onReleaseTrackPage = vi.fn<(page: ProviderReleaseTrackPage) => Promise<void>>();
    onReleaseTrackPage.mockResolvedValue(undefined);
    const provider = new SpotifyProvider({
      client,
      mappings: [{ artistId: "artist-1", name: "YUSSI", spotifyArtistId: "spotify-yussi" }],
    });

    await provider.scan({ filter: { provider: "spotify" }, onReleaseTrackPage });

    const firstPage = onReleaseTrackPage.mock.calls[0]?.[0];
    expect(Array.isArray(firstPage?.items)).toBe(true);
    expect(firstPage?.terminal).toBe(false);
    expect(onReleaseTrackPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 50, terminal: true }),
    );
  });
});

function spotifyTrack(position: number) {
  return {
    artists: [spotifyArtist],
    disc_number: position > 20 ? 2 : 1,
    duration_ms: 180_000,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/track-${position}` },
    id: `track-${position}`,
    is_local: false,
    is_playable: true,
    name: `Track ${position}`,
    track_number: position > 20 ? position - 20 : position,
    type: "track" as const,
    uri: `spotify:track:track-${position}`,
  };
}

function albumSummary(id: string, name: string, releaseDate: string): SpotifyAlbumSummary {
  return {
    album_type: "single",
    artists: [spotifyArtist],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
    id,
    images: [],
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
