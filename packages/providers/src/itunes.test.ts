import { describe, expect, it, vi } from "vitest";
import {
  assertAllowedItunesRequestUrl,
  buildItunesUrl,
  ItunesClient,
  ItunesClientError,
  type ItunesNormalizedResponse,
  type ItunesRequestPersistence,
  parseItunesResponse,
} from "./itunes";

class MemoryPersistence implements ItunesRequestPersistence {
  readonly completions: Array<Record<string, unknown>> = [];
  readonly permits: Array<Record<string, unknown>> = [];
  readonly cacheHits: Array<Record<string, unknown>> = [];
  cache: unknown = null;
  acquireError?: Error;

  acquire(input: Parameters<ItunesRequestPersistence["acquire"]>[0]) {
    if (this.acquireError) throw this.acquireError;
    this.permits.push(input);
    return Promise.resolve({
      eventId: `event-${this.permits.length}`,
      leaseToken: `lease-${this.permits.length}`,
      startedAt: new Date(),
    });
  }

  complete(input: Parameters<ItunesRequestPersistence["complete"]>[0]) {
    this.completions.push(input);
    if (input.cacheValue) this.cache = input.cacheValue;
    return Promise.resolve();
  }

  loadCache() {
    return Promise.resolve(this.cache);
  }

  recordCacheHit(input: Parameters<ItunesRequestPersistence["recordCacheHit"]>[0]) {
    this.cacheHits.push(input);
    return Promise.resolve();
  }
}

const artistResult = {
  artistId: 42,
  artistName: "A.M.C",
  artistViewUrl: "https://music.apple.com/us/artist/a-m-c/42",
  artworkUrl100: "https://example.invalid/art.jpg",
  previewUrl: "https://example.invalid/preview.m4a",
  primaryGenreName: "Dance",
  wrapperType: "artist",
};

const songResult = {
  artistId: 42,
  artistName: "A.M.C",
  collectionId: 7,
  collectionName: "Bass",
  kind: "song",
  previewUrl: "https://example.invalid/preview.m4a",
  releaseDate: "2026-07-01T00:00:00Z",
  trackId: 9,
  trackName: "Tune",
  trackTimeMillis: 180000,
  trackViewUrl: "https://itunes.apple.com/us/album/id7?i=9",
  wrapperType: "track",
};

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...(headers ? { headers } : {}),
    status,
  });
}

function client(
  persistence: MemoryPersistence,
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof ItunesClient>[0]> = {},
) {
  return new ItunesClient({
    enabled: true,
    fetchImpl,
    persistence,
    ...overrides,
  });
}

describe("iTunes response parsing", () => {
  it("parses exact artists and strips previews and artwork", () => {
    const parsed = parseItunesResponse({ resultCount: 1, results: [artistResult] });
    expect(parsed.artists).toEqual([
      {
        artistId: "42",
        artistName: "A.M.C",
        artistViewUrl: "https://music.apple.com/us/artist/a-m-c/42",
        primaryGenreName: "Dance",
        wrapperType: "artist",
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("preview");
    expect(JSON.stringify(parsed)).not.toContain("artwork");
  });

  it("preserves multiple candidates and no-result responses", () => {
    expect(
      parseItunesResponse({
        resultCount: 2,
        results: [artistResult, { ...artistResult, artistId: 43 }],
      }).artists,
    ).toHaveLength(2);
    expect(parseItunesResponse({ resultCount: 0, results: [] }).artists).toEqual([]);
  });

  it("ignores unknown and incomplete fields defensively", () => {
    const parsed = parseItunesResponse({
      resultCount: 2,
      results: [{ wrapperType: "mystery" }, songResult],
    });
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.unknownResultCount).toBe(1);
  });
});

describe("iTunes client safety", () => {
  it("requires explicit enablement", async () => {
    const persistence = new MemoryPersistence();
    const disabled = new ItunesClient({
      enabled: false,
      fetchImpl: vi.fn(),
      persistence,
    });
    await expect(disabled.searchArtists("run", "Artist")).rejects.toMatchObject({
      classification: "provider_disabled",
    });
  });

  it("uses only the documented artist search parameters", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ resultCount: 1, results: [artistResult] }));
    await client(persistence, fetchImpl).searchArtists("run", "A.M.C");
    const requestUrl = fetchImpl.mock.calls[0]?.[0];
    expect(requestUrl).toBeInstanceOf(URL);
    const url = new URL((requestUrl as URL).toString());
    expect(url.origin).toBe("https://itunes.apple.com");
    expect(url.pathname).toBe("/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      country: "US",
      entity: "musicArtist",
      explicit: "Yes",
      lang: "en_us",
      limit: "10",
      media: "music",
      term: "A.M.C",
    });
  });

  it("rejects unsafe schemes, hosts, credentials, and paths", () => {
    for (const value of [
      "http://itunes.apple.com/search",
      "https://itunes.apple.com.evil.example/search",
      "https://user:pass@itunes.apple.com/search",
      "https://itunes.apple.com/not-allowed",
    ]) {
      expect(() => assertAllowedItunesRequestUrl(new URL(value))).toThrow(ItunesClientError);
    }
    expect(buildItunesUrl("/lookup", { id: "42" }).hostname).toBe("itunes.apple.com");
  });

  it("handles malformed and oversized responses", async () => {
    const malformedPersistence = new MemoryPersistence();
    await expect(
      client(
        malformedPersistence,
        vi.fn<typeof fetch>().mockResolvedValue(response("{")),
      ).searchArtists("run", "Artist"),
    ).rejects.toMatchObject({ classification: "malformed_json" });

    const oversizedPersistence = new MemoryPersistence();
    await expect(
      client(
        oversizedPersistence,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response({ resultCount: 0, results: [] }, 200, { "content-length": "9999" }),
          ),
        { maxResponseBytes: 100 },
      ).searchArtists("run", "Artist"),
    ).rejects.toMatchObject({ classification: "response_too_large" });
  });

  it("classifies timeout, 403, 404, and 429 with Retry-After", async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      client(new MemoryPersistence(), timeoutFetch, { requestTimeoutMs: 5 }).searchArtists(
        "run",
        "Artist",
      ),
    ).rejects.toMatchObject({ classification: "timeout" });

    for (const [status, classification] of [
      [403, "forbidden"],
      [404, "not_found"],
    ] as const) {
      await expect(
        client(
          new MemoryPersistence(),
          vi.fn<typeof fetch>().mockResolvedValue(response({}, status)),
        ).searchArtists("run", "Artist"),
      ).rejects.toMatchObject({ classification, status });
    }
    await expect(
      client(
        new MemoryPersistence(),
        vi.fn<typeof fetch>().mockResolvedValue(response({}, 429, { "retry-after": "120" })),
      ).searchArtists("run", "Artist"),
    ).rejects.toMatchObject({
      classification: "rate_limited",
      retryAfterSeconds: 120,
      status: 429,
    });
  });

  it("bounds HTTP 500 retries at three attempts", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response({}, 500)));
    await expect(
      client(persistence, fetchImpl).searchArtists("run", "Artist"),
    ).rejects.toMatchObject({ classification: "server_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(persistence.permits).toHaveLength(3);
  });

  it("uses normalized persistent cache values for idempotent reruns", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ resultCount: 1, results: [artistResult] }));
    const instance = client(persistence, fetchImpl);
    const first = await instance.searchArtists("run", "Artist");
    const second = await instance.searchArtists("run", "Artist");
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persistence.cacheHits).toHaveLength(1);
  });

  it("propagates request-budget exhaustion before fetch", async () => {
    const persistence = new MemoryPersistence();
    persistence.acquireError = new Error("request_budget_exhausted");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(persistence, fetchImpl).searchArtists("run", "Artist")).rejects.toThrow(
      "request_budget_exhausted",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes collection and song lookups without preview data", async () => {
    const persistence = new MemoryPersistence();
    const normalized: ItunesNormalizedResponse = await client(
      persistence,
      vi.fn<typeof fetch>().mockResolvedValue(response({ resultCount: 1, results: [songResult] })),
    ).lookupSongs("run", ["42"]);
    expect(normalized.tracks[0]).toMatchObject({
      artistId: "42",
      collectionId: "7",
      trackId: "9",
    });
    expect(JSON.stringify(normalized)).not.toContain("previewUrl");
  });
});
