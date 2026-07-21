import type { SpotifyAlbum } from "@radar/providers";
import { SpotifyHttpError } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  parseSpotifyArtworkBackfillOptions,
  runSpotifyArtworkBackfill,
  spotifyArtworkBackfillMaximum,
  type SpotifyArtworkAlbumClient,
} from "./spotify-artwork-backfill";

describe("Spotify artwork backfill", () => {
  it("requires a bounded limit and defaults to dry-run", () => {
    expect(parseSpotifyArtworkBackfillOptions(["--limit", "5"])).toEqual({
      apply: false,
      limit: 5,
      resume: false,
    });
    expect(parseSpotifyArtworkBackfillOptions(["--apply", "--resume", "--limit", "2"])).toEqual({
      apply: true,
      limit: 2,
      resume: true,
    });
    expect(() => parseSpotifyArtworkBackfillOptions([])).toThrow("--limit");
    expect(() =>
      parseSpotifyArtworkBackfillOptions(["--limit", String(spotifyArtworkBackfillMaximum + 1)]),
    ).toThrow("--limit");
    expect(() =>
      parseSpotifyArtworkBackfillOptions(["--apply", "--dry-run", "--limit", "1"]),
    ).toThrow("either");
  });

  it("performs no writes in dry-run and uses album lookups only", async () => {
    const fixture = setup([release("row-1", "release-1", albumId("1"), "Hold On")]);
    const summary = await runSpotifyArtworkBackfill(
      { apply: false, limit: 1, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({
      dryRun: true,
      processed: 1,
      requests: 1,
      updated: 0,
      wouldUpdate: 1,
    });
    expect(fixture.repository.persistArtwork).not.toHaveBeenCalled();
    expect(fixture.repository.persistCursor).not.toHaveBeenCalled();
    expect(fixture.repository.markUnavailable).not.toHaveBeenCalled();
    expect(fixture.client.getAlbum).toHaveBeenCalledWith(albumId("1"));
  });

  it("persists artwork and progress after each release", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "Hold On"),
      release("row-2", "release-2", albumId("2"), "UNTAMED"),
    ]);
    const summary = await runSpotifyArtworkBackfill(
      { apply: true, limit: 2, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({ processed: 2, remaining: 0, updated: 2, wouldUpdate: 2 });
    expect(fixture.repository.persistArtwork).toHaveBeenCalledTimes(2);
    expect(fixture.repository.persistCursor).toHaveBeenNthCalledWith(1, "row-1");
    expect(fixture.repository.persistCursor).toHaveBeenNthCalledWith(2, "row-2");
  });

  it("skips valid artwork and malformed album IDs without a request", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "Existing", validProviderFields()),
      release("row-2", "release-2", "not-an-album-id", "Missing ID"),
    ]);
    const summary = await runSpotifyArtworkBackfill(
      { apply: true, limit: 2, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({ processed: 1, requests: 0, skipped: 1, unavailable: 1 });
    expect(fixture.client.getAlbum).not.toHaveBeenCalled();
    expect(fixture.repository.markUnavailable).toHaveBeenCalledOnce();
  });

  it("rejects unsafe image metadata as unavailable", async () => {
    const fixture = setup([release("row-1", "release-1", albumId("1"), "Unsafe")]);
    fixture.client.getAlbum.mockResolvedValueOnce(
      spotifyAlbum(albumId("1"), "https://example.com/image.jpg"),
    );
    const summary = await runSpotifyArtworkBackfill(
      { apply: true, limit: 1, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({ unavailable: 1, updated: 0 });
    expect(fixture.repository.persistArtwork).not.toHaveBeenCalled();
  });

  it("resumes after the persisted cursor", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "First"),
      release("row-2", "release-2", albumId("2"), "Second"),
    ]);
    fixture.repository.loadCursor.mockResolvedValue("row-1");
    const summary = await runSpotifyArtworkBackfill(
      { apply: false, limit: 1, resume: true },
      fixture,
    );

    expect(summary.selected).toEqual([{ internalReleaseId: "release-2", title: "Second" }]);
    expect(fixture.client.getAlbum).toHaveBeenCalledWith(albumId("2"));
  });

  it("selects distinct canonical releases when provider IDs converge", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "UNTAMED"),
      release("row-2", "release-1", albumId("2"), "UNTAMED"),
      release("row-3", "release-2", albumId("3"), "Hold On"),
    ]);
    const summary = await runSpotifyArtworkBackfill(
      { apply: false, limit: 2, resume: false },
      fixture,
    );

    expect(summary.selected).toEqual([
      { internalReleaseId: "release-1", title: "UNTAMED" },
      { internalReleaseId: "release-2", title: "Hold On" },
    ]);
    expect(fixture.client.getAlbum).toHaveBeenCalledTimes(2);
  });

  it("is idempotent when stored artwork is already valid", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "Existing", validProviderFields()),
    ]);
    const summary = await runSpotifyArtworkBackfill(
      { apply: true, limit: 1, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({ processed: 0, remaining: 0, requests: 0, skipped: 1 });
    expect(fixture.repository.persistArtwork).not.toHaveBeenCalled();
  });

  it("stops immediately on HTTP 429 without advancing progress", async () => {
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "First"),
      release("row-2", "release-2", albumId("2"), "Second"),
    ]);
    fixture.client.getAlbum.mockRejectedValueOnce(new SpotifyHttpError("limited", 429));
    const summary = await runSpotifyArtworkBackfill(
      { apply: true, limit: 2, resume: false },
      fixture,
    );

    expect(summary).toMatchObject({ failed: 1, processed: 1, stoppedReason: "rate_limited" });
    expect(fixture.client.getAlbum).toHaveBeenCalledTimes(1);
    expect(fixture.repository.persistCursor).not.toHaveBeenCalled();
  });

  it("reports a persisted cooldown without calling Spotify", async () => {
    const fixture = setup([release("row-1", "release-1", albumId("1"), "First")]);
    fixture.client.getAlbum.mockRejectedValueOnce(
      Object.assign(new Error("cooldown"), { code: "spotify_cooldown" }),
    );
    const summary = await runSpotifyArtworkBackfill(
      { apply: false, limit: 1, resume: false },
      fixture,
    );
    expect(summary).toMatchObject({ failed: 1, stoppedReason: "cooldown" });
    expect(fixture.repository.persistCursor).not.toHaveBeenCalled();
  });

  it("processes releases sequentially", async () => {
    let active = 0;
    let maximumActive = 0;
    const fixture = setup([
      release("row-1", "release-1", albumId("1"), "First"),
      release("row-2", "release-2", albumId("2"), "Second"),
    ]);
    fixture.client.getAlbum.mockImplementation(async (id: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return spotifyAlbum(id);
    });
    await runSpotifyArtworkBackfill({ apply: false, limit: 2, resume: false }, fixture);
    expect(maximumActive).toBe(1);
  });
});

function setup(releases: ReturnType<typeof release>[]) {
  const repository = {
    listReleases: vi.fn().mockResolvedValue(releases),
    loadCursor: vi.fn().mockResolvedValue(null),
    markUnavailable: vi.fn().mockResolvedValue(undefined),
    persistArtwork: vi.fn().mockResolvedValue(undefined),
    persistCursor: vi.fn().mockResolvedValue(undefined),
  };
  const getAlbum = vi.fn((id: string) => Promise.resolve(spotifyAlbum(id)));
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
  } satisfies SpotifyArtworkAlbumClient;
  return { client, repository };
}

function albumId(seed: string): string {
  return seed.padEnd(22, "A");
}

function release(
  externalRowId: string,
  releaseId: string,
  externalId: string,
  title: string,
  providerFields: unknown = {},
) {
  return { externalId, externalRowId, providerFields, releaseId, title };
}

function validProviderFields() {
  return {
    spotify: {
      albumId: albumId("1"),
      albumUrl: `https://open.spotify.com/album/${albumId("1")}`,
      image: { height: 300, url: "https://i.scdn.co/image/validart", width: 300 },
      lastObservedAt: "2026-07-21T12:00:00.000Z",
      sourceProvider: "spotify",
    },
  };
}

function spotifyAlbum(
  id: string,
  imageUrl = "https://i.scdn.co/image/backfilledart",
): SpotifyAlbum {
  return {
    album_type: "single",
    artists: [],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
    id,
    images: [{ height: 300, url: imageUrl, width: 300 }],
    name: "Album",
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
