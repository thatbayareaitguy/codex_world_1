import { describe, expect, it, vi } from "vitest";
import type { AppleMusicRequestPersistence } from "./apple-music";
import { ITunesIdentityClient } from "./itunes-identity";

describe("iTunes numeric artist identity lookup", () => {
  it("queries only the numeric Apple ID and persists a sanitized catalog", async () => {
    const persistence = fakePersistence();
    let requestedUrl = "";
    const client = new ITunesIdentityClient({
      fetchImpl: vi.fn((input) => {
        requestedUrl = String(input);
        return Promise.resolve(
          Response.json({
            resultCount: 2,
            results: [
              {
                artistId: 123,
                artistLinkUrl: "https://music.apple.com/us/artist/example/123",
                artistName: "Example Artist",
                primaryGenreName: "Dance",
                wrapperType: "artist",
              },
              {
                artistId: 123,
                artistName: "Example Artist",
                artistViewUrl: "https://music.apple.com/us/artist/example/123",
                artworkUrl100:
                  "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/example/100x100bb.jpg",
                collectionId: 456,
                collectionName: "Distinct Release",
                releaseDate: "2026-08-01T00:00:00Z",
                trackCount: 8,
                trackId: 789,
                trackName: "Distinct Track",
                wrapperType: "track",
              },
            ],
          }),
        );
      }),
      maxRequestsPerRun: 5,
      minRequestIntervalMs: 3_200,
      persistence,
      runId: "run-1",
    });

    const catalog = await client.getArtistCatalog("123");

    expect(new URL(requestedUrl).searchParams.get("id")).toBe("123");
    expect(requestedUrl).not.toContain("Example%20Artist");
    expect(catalog).toMatchObject({
      appleArtistId: "123",
      artistName: "Example Artist",
      genres: ["Dance"],
      resourceStatus: "valid",
      source: "itunes_lookup",
    });
    expect(catalog.releases).toHaveLength(1);
    expect(catalog.songs).toHaveLength(1);
    expect(persistence.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ minIntervalMs: 3_200 }),
    );
    expect(persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({ cacheValue: catalog, status: 200 }),
    );
  });

  it("treats an empty storefront lookup as unknown rather than safe elimination", async () => {
    const client = new ITunesIdentityClient({
      fetchImpl: vi.fn(() => Promise.resolve(Response.json({ resultCount: 0, results: [] }))),
      maxRequestsPerRun: 1,
      minRequestIntervalMs: 3_000,
      persistence: fakePersistence(),
      runId: "run-2",
    });
    await expect(client.getArtistCatalog("999")).resolves.toMatchObject({
      resourceStatus: "unknown",
    });
  });

  it("persists a provider cooldown when Retry-After accompanies HTTP 429", async () => {
    const persistence = fakePersistence();
    const client = new ITunesIdentityClient({
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          new Response("rate limited", { status: 429, headers: { "Retry-After": "12" } }),
        ),
      ),
      maxRequestsPerRun: 1,
      minRequestIntervalMs: 3_000,
      persistence,
      runId: "run-3",
    });
    await expect(client.getArtistCatalog("123")).rejects.toThrow("HTTP 429");
    expect(persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({ retryAfterSeconds: 12, status: 429 }),
    );
  });
});

function fakePersistence() {
  return {
    acquire: vi.fn(() =>
      Promise.resolve({
        eventId: "event-1",
        leaseToken: "lease-1",
        startedAt: new Date(),
      }),
    ),
    complete: vi.fn(() => Promise.resolve()),
    loadCache: vi.fn(() => Promise.resolve(null)),
    recordCacheHit: vi.fn(() => Promise.resolve()),
  } satisfies AppleMusicRequestPersistence;
}
