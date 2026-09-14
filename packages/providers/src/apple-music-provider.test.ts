import { describe, expect, it, vi } from "vitest";
import {
  AppleMusicClientError,
  AppleMusicProvider,
  type AppleMusicAlbum,
  type AppleMusicClient,
  type AppleMusicSong,
} from "./apple-music";

describe("Apple Music shallow discovery provider", () => {
  it("reads only first artist-view pages and fetches tracks only for releases in the window", async () => {
    const recent = album("recent", "2026-08-01", "singles");
    const old = album("old", "2026-06-01", "full-albums");
    const getArtistViewFirstPage = vi.fn((_artistId: string, view: string) =>
      Promise.resolve({
        items: view === "singles" ? [recent] : [old],
        nextPresent: true,
      }),
    );
    const getAlbumTracks = vi.fn((albumId: string) => Promise.resolve([song(albumId)]));
    const client = { getAlbumTracks, getArtistViewFirstPage } as unknown as AppleMusicClient;
    const batches: Array<{ candidates: number; partial?: boolean; releases: number }> = [];
    const provider = new AppleMusicProvider(
      client,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
      () => new Date("2026-08-04T12:00:00.000Z"),
      "test-run",
    );

    const result = await provider.scan({
      filter: { provider: "apple_music", since: "2026-07-05" },
      onBatch: (batch) => {
        batches.push({
          candidates: batch.candidates.length,
          ...(batch.partial === undefined ? {} : { partial: batch.partial }),
          releases: batch.releases?.length ?? 0,
        });
        return Promise.resolve();
      },
    });

    expect(getArtistViewFirstPage).toHaveBeenCalledTimes(2);
    expect(getAlbumTracks).toHaveBeenCalledTimes(1);
    expect(getAlbumTracks).toHaveBeenCalledWith(
      "recent",
      undefined,
      expect.stringContaining("test-run"),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      artistName: "Artist",
      externalReleaseId: "recent",
      provider: "apple_music",
      releaseDate: "2026-08-01",
    });
    expect(batches).toEqual([{ candidates: 1, partial: true, releases: 1 }]);
  });

  it("treats one missing optional artist view as empty", async () => {
    const recent = album("recent", "2026-08-01", "singles");
    const getArtistViewFirstPage = vi.fn((_artistId: string, view: string) =>
      view === "singles"
        ? Promise.resolve({ items: [recent], nextPresent: false })
        : Promise.reject(new AppleMusicClientError("Not found", "not_found", 404)),
    );
    const getAlbumTracks = vi.fn((albumId: string) => Promise.resolve([song(albumId)]));
    const provider = new AppleMusicProvider(
      { getAlbumTracks, getArtistViewFirstPage } as unknown as AppleMusicClient,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
    );

    const result = await provider.scan({
      filter: { provider: "apple_music", since: "2026-07-05" },
    });

    expect(result.candidates).toHaveLength(1);
    expect(getAlbumTracks).toHaveBeenCalledTimes(1);
  });

  it("reports a missing artist when both discovery views are absent", async () => {
    const getArtistViewFirstPage = vi.fn(() =>
      Promise.reject(new AppleMusicClientError("Not found", "not_found", 404)),
    );
    const getArtist = vi.fn(() =>
      Promise.reject(new AppleMusicClientError("Not found", "not_found", 404)),
    );
    const provider = new AppleMusicProvider(
      {
        getArtist,
        getAlbumTracks: vi.fn(),
        getArtistViewFirstPage,
      } as unknown as AppleMusicClient,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
    );

    await expect(
      provider.scan({ filter: { provider: "apple_music", since: "2026-07-05" } }),
    ).rejects.toMatchObject({ classification: "not_found", status: 404 });
    expect(getArtistViewFirstPage).toHaveBeenCalledTimes(2);
    expect(getArtist).toHaveBeenCalledTimes(1);
  });

  it("records a valid artist with no release views as a successful no-result scan", async () => {
    const getArtistViewFirstPage = vi.fn(() =>
      Promise.reject(new AppleMusicClientError("Not found", "not_found", 404)),
    );
    const getArtist = vi.fn(() =>
      Promise.resolve({
        artistId: "101",
        evidenceUrl: "https://music.apple.com/us/artist/artist/101",
        genreNames: ["Electronic"],
        name: "Artist",
        sourceStorefront: "us",
      }),
    );
    const provider = new AppleMusicProvider(
      {
        getArtist,
        getAlbumTracks: vi.fn(),
        getArtistViewFirstPage,
      } as unknown as AppleMusicClient,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
    );

    await expect(
      provider.scan({ filter: { provider: "apple_music", since: "2026-07-05" } }),
    ).resolves.toEqual({ candidates: [] });
    expect(getArtistViewFirstPage).toHaveBeenCalledTimes(2);
    expect(getArtist).toHaveBeenCalledTimes(1);
  });

  it("skips one unavailable release without losing valid releases for the artist", async () => {
    const unavailable = album("unavailable", "2026-08-02", "singles");
    const recent = album("recent", "2026-08-01", "singles");
    const getArtistViewFirstPage = vi.fn((_artistId: string, view: string) =>
      Promise.resolve({
        items: view === "singles" ? [unavailable, recent] : [],
        nextPresent: false,
      }),
    );
    const getAlbumTracks = vi.fn((albumId: string) =>
      albumId === "unavailable"
        ? Promise.reject(new AppleMusicClientError("Not found", "not_found", 404))
        : Promise.resolve([song(albumId)]),
    );
    const batches: Array<{ candidates: number; releases: number }> = [];
    const provider = new AppleMusicProvider(
      { getAlbumTracks, getArtistViewFirstPage } as unknown as AppleMusicClient,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
    );

    const result = await provider.scan({
      filter: { provider: "apple_music", since: "2026-07-05" },
      onBatch: (batch) => {
        batches.push({
          candidates: batch.candidates.length,
          releases: batch.releases?.length ?? 0,
        });
        return Promise.resolve();
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.externalReleaseId).toBe("recent");
    expect(batches).toEqual([{ candidates: 1, releases: 2 }]);
  });

  it("keeps announced prerelease songs, skips unresolved placeholders, and marks them upcoming", async () => {
    const prerelease = {
      ...album("prerelease", "2026-09-25", "full-albums"),
      isComplete: false,
      trackCount: 3,
    };
    const getArtistViewFirstPage = vi.fn((_artistId: string, view: string) =>
      Promise.resolve({
        items: view === "full-albums" ? [prerelease] : [],
        nextPresent: false,
      }),
    );
    const placeholder = {
      ...song("prerelease"),
      releaseDate: "2026-09-25",
      songId: "placeholder-song",
      title: "Track 1",
    };
    const announced = {
      ...song("prerelease"),
      releaseDate: "2026-09-25",
      songId: "announced-song",
      title: "Announced Song",
      trackNumber: 2,
    };
    const provider = new AppleMusicProvider(
      {
        getAlbumTracks: vi.fn(() => Promise.resolve([placeholder, announced])),
        getArtistViewFirstPage,
      } as unknown as AppleMusicClient,
      [{ appleArtistId: "101", canonicalArtistId: "canonical-1", canonicalName: "Artist" }],
      () => new Date("2026-08-04T12:00:00.000Z"),
    );

    const result = await provider.scan({
      filter: { provider: "apple_music", since: "2026-07-05" },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalTrackId: "announced-song",
      isUpcoming: true,
      title: "Announced Song",
    });
  });
});

function album(
  albumId: string,
  releaseDate: string,
  sourceView: AppleMusicAlbum["sourceView"],
): AppleMusicAlbum {
  return {
    albumId,
    artistIds: ["101"],
    artistName: "Artist",
    evidenceUrl: `https://music.apple.com/us/album/${albumId}`,
    genreNames: ["Electronic"],
    isComplete: true,
    isSingle: sourceView === "singles",
    paginationPath: `/v1/catalog/us/albums/${albumId}`,
    pageNumber: 1,
    releaseDate,
    sourceStorefront: "us",
    sourceView,
    title: `Release ${albumId}`,
    trackCount: 1,
  };
}

function song(albumId: string): AppleMusicSong {
  return {
    albumId,
    albumName: `Release ${albumId}`,
    artistIds: ["101"],
    artistName: "Artist",
    discNumber: 1,
    durationMs: 180_000,
    evidenceUrl: `https://music.apple.com/us/album/${albumId}`,
    isrc: "USAAA2600001",
    paginationPath: `/v1/catalog/us/albums/${albumId}/tracks`,
    pageNumber: 1,
    releaseDate: "2026-08-01",
    songId: "song-1",
    sourceStorefront: "us",
    title: "Recent Track",
    trackNumber: 1,
  };
}
