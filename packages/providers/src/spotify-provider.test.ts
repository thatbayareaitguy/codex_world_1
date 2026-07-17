import { describe, expect, it, vi } from "vitest";
import { SpotifyProvider } from "./spotify-provider";
import type { SpotifyClient } from "./spotify";

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
});
