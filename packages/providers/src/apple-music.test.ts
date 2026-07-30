import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AppleDeveloperTokenManager,
  AppleMusicAuthenticationError,
  AppleMusicClient,
  AppleMusicClientError,
  appleMusicArtistViews,
  assertAllowedAppleMusicPath,
  assertAllowedAppleMusicUrl,
  parseAppleRetryAfter,
  type AppleMusicRequestPersistence,
} from "./apple-music";

class MemoryPersistence implements AppleMusicRequestPersistence {
  readonly cacheHits: Array<Record<string, unknown>> = [];
  readonly completions: Array<Parameters<AppleMusicRequestPersistence["complete"]>[0]> = [];
  readonly permits: Array<Parameters<AppleMusicRequestPersistence["acquire"]>[0]> = [];
  readonly cache = new Map<string, unknown>();
  private readonly identities = new Map<string, string>();
  acquireError?: Error;
  active = 0;
  maximumActive = 0;

  acquire(
    input: Parameters<AppleMusicRequestPersistence["acquire"]>[0],
  ): ReturnType<AppleMusicRequestPersistence["acquire"]> {
    if (this.acquireError) return Promise.reject(this.acquireError);
    this.permits.push(input);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    const eventId = `event-${this.permits.length}`;
    this.identities.set(eventId, input.identity);
    return Promise.resolve({
      eventId,
      leaseToken: `lease-${this.permits.length}`,
      startedAt: new Date(),
    });
  }

  complete(
    input: Parameters<AppleMusicRequestPersistence["complete"]>[0],
  ): ReturnType<AppleMusicRequestPersistence["complete"]> {
    this.completions.push(input);
    this.active -= 1;
    const identity = this.identities.get(input.eventId);
    if (identity && input.cacheValue !== undefined) this.cache.set(identity, input.cacheValue);
    return Promise.resolve();
  }

  loadCache(identity: string): ReturnType<AppleMusicRequestPersistence["loadCache"]> {
    return Promise.resolve(this.cache.get(identity) ?? null);
  }

  recordCacheHit(
    input: Parameters<AppleMusicRequestPersistence["recordCacheHit"]>[0],
  ): ReturnType<AppleMusicRequestPersistence["recordCacheHit"]> {
    this.cacheHits.push(input);
    return Promise.resolve();
  }
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const testPrivateKey = privateKey.export({ format: "pem", type: "pkcs8" });

const artist = (id = "42", name = "Artist") => ({
  attributes: {
    artwork: { url: "https://example.invalid/{w}x{h}.jpg" },
    genreNames: ["Dance"],
    name,
    url: `https://music.apple.com/us/artist/${id}`,
  },
  href: `/v1/catalog/us/artists/${id}`,
  id,
  relationships: {
    albums: {
      data: [],
      href: `/v1/catalog/us/artists/${id}/albums`,
      next: `/v1/catalog/us/artists/${id}/albums?offset=25`,
    },
  },
  type: "artists",
});

const album = (id = "album-1", overrides: Record<string, unknown> = {}) => ({
  attributes: {
    artistName: "Artist",
    genreNames: ["Dance"],
    isSingle: false,
    name: "Album",
    releaseDate: "2026-07-01",
    trackCount: 2,
    upc: "123456789012",
    url: `https://music.apple.com/us/album/${id}`,
    ...overrides,
  },
  href: `/v1/catalog/us/albums/${id}`,
  id,
  relationships: {
    artists: {
      data: [{ id: "42", type: "artists" }],
      href: "https://outside.invalid/embedded-artists",
      next: "/v1/me/library/artists",
    },
    tracks: {
      data: [],
      href: `/v1/catalog/us/albums/${id}/tracks`,
      next: "https://outside.invalid/embedded-tracks",
    },
  },
  type: "albums",
  unknownTopLevelField: "ignored",
});

const song = (
  id: string,
  discNumber = 1,
  trackNumber = 1,
  overrides: Record<string, unknown> = {},
) => ({
  attributes: {
    artistName: "Artist",
    discNumber,
    durationInMillis: 180_000,
    isrc: `USAAA26000${trackNumber}`,
    name: `Song ${id}`,
    previewUrl: "https://example.invalid/preview.m4a",
    releaseDate: "2026-07-01",
    trackNumber,
    url: `https://music.apple.com/us/song/${id}`,
    ...overrides,
  },
  href: `/v1/catalog/us/songs/${id}`,
  id,
  relationships: {
    albums: {
      data: [{ id: "album-1", type: "albums" }],
      next: "https://outside.invalid/embedded-albums",
    },
    artists: {
      data: [{ id: "42", type: "artists" }],
      next: "/v1/me/library/artists",
    },
  },
  type: "songs",
});

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...(headers ? { headers } : {}),
    status,
  });
}

function createClient(
  persistence: MemoryPersistence,
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof AppleMusicClient>[0]> = {},
) {
  return new AppleMusicClient({
    enabled: true,
    fetchImpl,
    persistence,
    runId: "00000000-0000-4000-8000-000000000001",
    tokenProvider: { getToken: () => "synthetic-token" },
    ...overrides,
  });
}

function decodePart(token: string, index: number): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[index]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("Apple developer-token authentication", () => {
  it("generates and caches a valid ES256 token with bounded claims", () => {
    const now = new Date("2026-07-29T00:00:00Z");
    const readPrivateKey = vi.fn(() => testPrivateKey);
    const manager = new AppleDeveloperTokenManager({
      keyId: "ABCDE12345",
      now: () => now,
      privateKeyPath: "C:\\external\\synthetic.p8",
      readPrivateKey,
      teamId: "TEAMID1234",
      tokenLifetimeSeconds: 3_600,
    });
    const first = manager.getToken();
    const second = manager.getToken();
    expect(second).toBe(first);
    expect(readPrivateKey).toHaveBeenCalledTimes(1);
    expect(decodePart(first, 0)).toEqual({
      alg: "ES256",
      kid: "ABCDE12345",
      typ: "JWT",
    });
    expect(decodePart(first, 1)).toEqual({
      exp: Math.floor(now.getTime() / 1_000) + 3_600,
      iat: Math.floor(now.getTime() / 1_000),
      iss: "TEAMID1234",
    });
    expect(Buffer.from(first.split(".")[2]!, "base64url")).toHaveLength(64);
  });

  it("regenerates before expiration and rejects invalid identifiers and key material", () => {
    let now = new Date("2026-07-29T00:00:00Z");
    const manager = new AppleDeveloperTokenManager({
      keyId: "ABCDE12345",
      now: () => now,
      privateKeyPath: "C:\\external\\synthetic.p8",
      readPrivateKey: () => testPrivateKey,
      teamId: "TEAMID1234",
      tokenLifetimeSeconds: 600,
    });
    const first = manager.getToken();
    now = new Date("2026-07-29T00:09:10Z");
    expect(manager.getToken()).not.toBe(first);

    for (const options of [
      { keyId: "short", teamId: "TEAMID1234" },
      { keyId: "ABCDE12345", teamId: "short" },
    ]) {
      expect(
        () =>
          new AppleDeveloperTokenManager({
            ...options,
            privateKeyPath: "C:\\external\\synthetic.p8",
          }),
      ).toThrow(AppleMusicAuthenticationError);
    }
    expect(
      () =>
        new AppleDeveloperTokenManager({
          keyId: "ABCDE12345",
          privateKeyPath: "relative.p8",
          teamId: "TEAMID1234",
        }),
    ).toThrow("absolute");
  });

  it("fails safely for a missing key or invalid key type without exposing secret values", () => {
    const missing = new AppleDeveloperTokenManager({
      keyId: "ABCDE12345",
      privateKeyPath: "C:\\external\\missing.p8",
      readPrivateKey: () => {
        throw new Error("secret-path-and-key-material");
      },
      teamId: "TEAMID1234",
    });
    expect(() => missing.getToken()).toThrow("private key is unavailable");
    expect(() => missing.getToken()).not.toThrow("secret-path-and-key-material");

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const invalid = new AppleDeveloperTokenManager({
      keyId: "ABCDE12345",
      privateKeyPath: "C:\\external\\synthetic.p8",
      readPrivateKey: () => rsa,
      teamId: "TEAMID1234",
    });
    expect(() => invalid.getToken()).toThrow("EC private key");
  });
});

describe("Apple Music HTTP safety", () => {
  it("requires explicit enablement and exact catalog-only HTTPS URLs", async () => {
    const persistence = new MemoryPersistence();
    const disabled = new AppleMusicClient({
      enabled: false,
      fetchImpl: vi.fn(),
      persistence,
      runId: "run",
      tokenProvider: { getToken: () => "synthetic" },
    });
    await expect(disabled.searchArtists("Artist")).rejects.toMatchObject({
      classification: "provider_disabled",
    });
    for (const unsafe of [
      "http://api.music.apple.com/v1/catalog/us/artists/42",
      "https://api.music.apple.com.evil.example/v1/catalog/us/artists/42",
      "https://user:pass@api.music.apple.com/v1/catalog/us/artists/42",
      "https://api.music.apple.com/v1/me/library",
      "https://api.music.apple.com/v1/catalog/us/playlists/42",
      "https://api.music.apple.com/v1/catalog/us/genres",
      "https://api.music.apple.com/v1/catalog/us/stations/42",
      "https://api.music.apple.com/v1/catalog/us/music-videos/42",
      "https://api.music.apple.com/v1/catalog/us/recommendations",
      "https://api.music.apple.com/v1/catalog/us/charts",
      "https://api.music.apple.com/v1/catalog/gb/artists/42",
    ]) {
      expect(() => assertAllowedAppleMusicUrl(new URL(unsafe), "us")).toThrow(
        AppleMusicClientError,
      );
    }
    expect(assertAllowedAppleMusicPath("/v1/catalog/us/artists/42", "us")).toBe(
      "/v1/catalog/us/artists/42",
    );
  });

  it("times out, bounds response bodies, and rejects malformed JSON", async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      createClient(new MemoryPersistence(), timeoutFetch, {
        requestTimeoutMs: 5,
      }).searchArtists("Artist"),
    ).rejects.toMatchObject({ classification: "timeout" });

    const oversized = new MemoryPersistence();
    await expect(
      createClient(
        oversized,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse("x".repeat(2_000))),
        { maxResponseBytes: 1_024 },
      ).searchArtists("Artist"),
    ).rejects.toMatchObject({ classification: "response_too_large" });
    expect(oversized.completions).toHaveLength(1);

    const malformed = new MemoryPersistence();
    await expect(
      createClient(
        malformed,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse("{")),
      ).searchArtists("Artist"),
    ).rejects.toMatchObject({ classification: "malformed_json" });
    expect(malformed.completions).toHaveLength(1);
    expect(malformed.cache).toHaveLength(0);
  });

  it("classifies HTTP failures, persists 429 cooldown evidence, and parses Retry-After", async () => {
    for (const [status, classification] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
    ] as const) {
      await expect(
        createClient(
          new MemoryPersistence(),
          vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status)),
        ).searchArtists("Artist"),
      ).rejects.toMatchObject({ classification, status });
    }
    const persistence = new MemoryPersistence();
    const fixedNow = new Date("2026-07-29T00:00:00Z");
    await expect(
      createClient(
        persistence,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 429, { "retry-after": "120" })),
        { now: () => fixedNow },
      ).searchArtists("Artist"),
    ).rejects.toMatchObject({
      classification: "rate_limited",
      retryAfterSeconds: 120,
      status: 429,
    });
    expect(persistence.completions[0]).toMatchObject({
      cooldownUntil: new Date("2026-07-29T00:02:00Z"),
      errorClassification: "rate_limited",
      retryAfterSeconds: 120,
    });
    expect(parseAppleRetryAfter("Wed, 29 Jul 2026 00:00:05 GMT", fixedNow)).toBe(5);
    expect(parseAppleRetryAfter("invalid", fixedNow)).toBeUndefined();
  });

  it("retries temporary 500 responses only within the configured bound", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({}, 500)));
    await expect(
      createClient(persistence, fetchImpl, {
        maxRetries: 2,
        sleep: () => Promise.resolve(),
      }).searchArtists("Artist"),
    ).rejects.toMatchObject({ classification: "temporary_server_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(persistence.permits).toHaveLength(3);
    expect(persistence.completions).toHaveLength(3);
  });

  it("reuses normalized cache entries idempotently without persisting tokens or raw media", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [artist()] }));
    const instance = createClient(persistence, fetchImpl);
    const first = await instance.getArtist("42");
    const second = await instance.getArtist("42");
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persistence.cacheHits).toHaveLength(1);
    const serialized = JSON.stringify(persistence);
    expect(serialized).not.toContain("synthetic-token");
    expect(serialized).not.toContain("artwork");
    expect(serialized).not.toContain("preview");
    expect(serialized).not.toContain("music.apple.com");
    expect(serialized).not.toContain('"href"');
    expect(serialized).not.toContain('"url"');
  });

  it("enforces request and runtime budgets before HTTP", async () => {
    const requestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [artist()] }));
    const requestClient = createClient(new MemoryPersistence(), requestFetch, {
      maxRequestsPerRun: 1,
    });
    await requestClient.getArtist("42");
    await expect(requestClient.getArtist("43")).rejects.toMatchObject({
      classification: "request_budget_exhausted",
    });
    expect(requestFetch).toHaveBeenCalledTimes(1);

    let now = new Date("2026-07-29T00:00:00Z");
    const runtimeFetch = vi.fn<typeof fetch>();
    const runtimeClient = createClient(new MemoryPersistence(), runtimeFetch, {
      maximumRuntimeMs: 1_000,
      now: () => now,
    });
    now = new Date("2026-07-29T00:00:02Z");
    await expect(runtimeClient.getArtist("42")).rejects.toMatchObject({
      classification: "runtime_budget_exhausted",
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
});

describe("Apple Music response URL categories and cache ordering", () => {
  it("keeps embedded relationship navigation inert and caches only artist identity", async () => {
    for (const descriptiveUrl of ["https://music.apple.com/us/artist/synthetic", "not a URL"]) {
      const persistence = new MemoryPersistence();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: [
            {
              ...artist(),
              attributes: {
                ...artist().attributes,
                url: descriptiveUrl,
              },
              href: "https://outside.invalid/non-followed-resource",
              relationships: {
                ...artist().relationships,
                unsupported: {
                  data: [],
                  href: "https://outside.invalid/unknown-href",
                  next: "/v1/me/library/unknown",
                },
              },
              unexpectedUrl: "https://untrusted.invalid/must-not-be-used",
            },
          ],
          next: "https://outside.invalid/non-paginated-response-next",
        }),
      );
      await expect(createClient(persistence, fetchImpl).getArtist("42")).resolves.toEqual(
        expect.objectContaining({ artistId: "42", name: "Artist" }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
      expect(persistence.cache).toHaveLength(1);
      const cache = JSON.stringify([...persistence.cache.values()]);
      expect(cache).not.toContain("music.apple.com");
      expect(cache).not.toContain("untrusted.invalid");
      expect(cache).not.toContain("outside.invalid");
      expect(cache).not.toContain("/v1/me");
      expect(cache).not.toContain('"href"');
      expect(cache).not.toContain('"next"');
      expect(cache).not.toContain('"url"');
    }
  });

  it("accepts same-host absolute pagination and stores only normalized relative navigation", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [album("first")],
          next: "https://api.music.apple.com/v1/catalog/us/artists/42/view/singles?offset=1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [album("second")] }));
    const result = await createClient(persistence, fetchImpl).getArtistView("42", "singles");
    expect(result.map((value) => value.albumId)).toEqual(["first", "second"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((persistence.completions[0]?.cacheValue as { next?: string } | undefined)?.next).toBe(
      "/v1/catalog/us/artists/42/view/singles?offset=1",
    );
  });

  it("discards search-result navigation because search pagination is not implemented", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: {
          artists: {
            data: [artist()],
            href: "https://outside.invalid/non-followed-search",
            next: "/v1/me/library/search",
          },
        },
      }),
    );
    await expect(createClient(persistence, fetchImpl).searchArtists("Artist")).resolves.toEqual([
      expect.objectContaining({ artistId: "42", name: "Artist" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cache = JSON.stringify([...persistence.cache.values()]);
    expect(cache).not.toContain("outside.invalid");
    expect(cache).not.toContain("/v1/me");
    expect(cache).not.toContain('"href"');
    expect(cache).not.toContain('"next"');
  });

  it.each([
    [
      "cross-host",
      "https://outside.invalid/v1/catalog/us/artists/private-id/view/singles?token=secret",
      "cross_host",
    ],
    ["non-catalog", "/unrelated/path", "non_catalog_path"],
    ["personal scope", "/v1/me/library", "personal_scope"],
    ["wrong storefront", "/v1/catalog/gb/artists/42/view/singles?offset=1", "wrong_storefront"],
    ["unsupported family", "/v1/catalog/us/playlists/playlist?offset=1", "outside_allowlist"],
    [
      "unsupported query",
      "/v1/catalog/us/artists/42/view/singles?secret=value",
      "unsupported_query",
    ],
  ])(
    "rejects %s pagination before caching or making a subsequent request",
    async (_, next, reason) => {
      const persistence = new MemoryPersistence();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [], next }));
      const failure = await createClient(persistence, fetchImpl)
        .getArtistView("42", "singles")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppleMusicClientError);
      expect(failure).toMatchObject({
        classification: "unsafe_url",
        urlDiagnostic: {
          fieldPath: "response.next",
          reason,
          role: "pagination",
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(persistence.cache).toHaveLength(0);
      expect(persistence.active).toBe(0);
      const evidence = JSON.stringify({ error: failure, telemetry: persistence.completions });
      for (const prohibited of [
        "outside.invalid",
        "private-id",
        "token=secret",
        "synthetic-token",
        "authorization",
        "/v1/me/library",
        "/unrelated/path",
        "/v1/catalog/gb",
        "/v1/catalog/us/playlists",
        "secret=value",
      ]) {
        expect(evidence).not.toContain(prohibited);
      }
    },
  );

  it.each([
    ["another operation", "/v1/catalog/us/albums/album-1/tracks?offset=1", "operation_mismatch"],
    ["another artist", "/v1/catalog/us/artists/99/view/singles?offset=1", "resource_mismatch"],
    ["another view", "/v1/catalog/us/artists/42/view/full-albums?offset=1", "resource_mismatch"],
  ])("rejects pagination owned by %s", async (_, next, reason) => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [], next }));
    await expect(
      createClient(persistence, fetchImpl).getArtistView("42", "singles"),
    ).rejects.toMatchObject({
      classification: "unsafe_url",
      urlDiagnostic: {
        operation: "artist_view",
        reason,
        role: "pagination",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persistence.cache).toHaveLength(0);
  });

  it("rejects album-track pagination for another album before a second request", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [],
        next: "/v1/catalog/us/albums/album-2/tracks?offset=1",
      }),
    );
    await expect(
      createClient(persistence, fetchImpl).getAlbumTracks("album-1"),
    ).rejects.toMatchObject({
      classification: "unsafe_url",
      urlDiagnostic: {
        operation: "album_tracks",
        reason: "resource_mismatch",
        route: "album_tracks",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persistence.cache).toHaveLength(0);
  });

  it("rejects repeated pagination without a third request", async () => {
    const firstOrder = "/v1/catalog/us/artists/42/view/singles?offset=1&limit=100";
    const reordered = "/v1/catalog/us/artists/42/view/singles?limit=100&offset=1";
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [], next: firstOrder }))
      .mockResolvedValueOnce(jsonResponse({ data: [], next: reordered }));
    await expect(
      createClient(persistence, fetchImpl).getArtistView("42", "singles"),
    ).rejects.toMatchObject({ classification: "duplicate_next_page" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("creates no cache entry for schema or normalization failure", async () => {
    for (const body of [
      { data: [{ id: "42", type: "not-artists" }] },
      { data: [{ href: "/v1/catalog/us/artists/42", id: "42", type: "artists" }] },
    ]) {
      const persistence = new MemoryPersistence();
      await expect(
        createClient(
          persistence,
          vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)),
        ).getArtist("42"),
      ).rejects.toMatchObject({ classification: "invalid_payload" });
      expect(persistence.cache).toHaveLength(0);
      expect(persistence.completions).toHaveLength(1);
      expect(persistence.completions[0]?.cacheValue).toBeUndefined();
      expect(persistence.active).toBe(0);
    }
  });
});

describe("Apple Music catalog operations", () => {
  it("searches and fetches single and batched artists with missing and duplicate IDs", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ results: { artists: { data: [artist()] } } }))
      .mockResolvedValueOnce(jsonResponse({ data: [artist()] }))
      .mockResolvedValueOnce(jsonResponse({ data: [artist("42"), artist("44")] }));
    const instance = createClient(persistence, fetchImpl);
    expect(await instance.searchArtists(" Artist ")).toHaveLength(1);
    expect(await instance.getArtist("42")).toMatchObject({ artistId: "42" });
    expect(await instance.getArtists(["42", "42", "43", "44"])).toMatchObject({
      items: [{ artistId: "42" }, { artistId: "44" }],
      missingIds: ["43"],
    });
    const searchInput = fetchImpl.mock.calls[0]?.[0];
    expect(searchInput).toBeInstanceOf(URL);
    if (!(searchInput instanceof URL)) throw new Error("Expected an Apple Music URL.");
    const searchUrl = new URL(searchInput.toString());
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({
      limit: "25",
      term: "Artist",
      types: "artists",
    });
  });

  it("rejects artist batches over 25 before HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      createClient(new MemoryPersistence(), fetchImpl).getArtists(
        Array.from({ length: 26 }, (_, index) => String(index + 1)),
      ),
    ).rejects.toMatchObject({ classification: "batch_limit_exceeded" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retrieves all six views sequentially and supports embedded view resources", async () => {
    const persistence = new MemoryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({ data: [album()] })));
    const instance = createClient(persistence, fetchImpl);
    const views = await instance.getAllArtistViews("42");
    expect(Object.keys(views)).toEqual(appleMusicArtistViews);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(persistence.maximumActive).toBe(1);
    expect(
      instance.embeddedArtistView(
        {
          ...artist(),
          views: {
            singles: {
              data: [album("embedded", { isSingle: true })],
              href: "https://outside.invalid/non-followed-view",
              next: "/v1/me/library/albums",
            },
          },
        },
        "singles",
      ),
    ).toEqual([expect.objectContaining({ albumId: "embedded", sourceView: "singles" })]);
  });

  it("follows direct-view pagination, deduplicates releases, and rejects bad next links", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [album("older", { releaseDate: "2026-06-01" })],
          next: "/v1/catalog/us/artists/42/view/full-albums?offset=1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            album("older", { releaseDate: "2026-06-01" }),
            album("newer", { releaseDate: "2026-07-01" }),
          ],
        }),
      );
    const albums = await createClient(new MemoryPersistence(), fetchImpl).getArtistView(
      "42",
      "full-albums",
    );
    expect(albums.map((value) => value.albumId)).toEqual(["newer", "older"]);
    expect(albums[1]).toMatchObject({ pageNumber: 1 });

    for (const next of [
      "/v1/catalog/us/artists/42/view/singles?offset=0",
      "https://evil.example/v1/catalog/us/artists/42/view/singles",
    ]) {
      const badFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [], next }));
      await expect(
        createClient(new MemoryPersistence(), badFetch).getArtistView("42", "singles"),
      ).rejects.toBeInstanceOf(AppleMusicClientError);
    }
  });

  it("fetches album details and paginated multi-disc tracks in local position order", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [album()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [song("disc-two", 2, 1)],
          next: "/v1/catalog/us/albums/album-1/tracks?offset=1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [song("second", 1, 2), song("first", 1, 1)] }));
    const instance = createClient(new MemoryPersistence(), fetchImpl);
    expect(await instance.getAlbum("album-1")).toMatchObject({
      albumId: "album-1",
      upc: "123456789012",
    });
    const tracks = await instance.getAlbumTracks("album-1");
    expect(tracks.map((value) => value.songId)).toEqual(["first", "second", "disc-two"]);
    expect(tracks[0]).toMatchObject({
      albumId: "album-1",
      discNumber: 1,
      isrc: "USAAA260001",
      trackNumber: 1,
    });
  });

  it("handles batched songs, missing optionals, and unknown fields without previews", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          song("1"),
          {
            attributes: { artistName: "Artist", genreNames: [], name: "Minimal" },
            id: "2",
            type: "songs",
            unknown: "ignored",
          },
        ],
      }),
    );
    const result = await createClient(new MemoryPersistence(), fetchImpl).getSongs([
      "1",
      "1",
      "2",
      "3",
    ]);
    expect(result.missingIds).toEqual(["3"]);
    expect(result.items[1]).toEqual(
      expect.objectContaining({ artistIds: [], songId: "2", title: "Minimal" }),
    );
    expect(JSON.stringify(result)).not.toContain("preview");
  });

  it("discards non-followed resource href values instead of treating them as requests", async () => {
    for (const href of ["https://evil.example/v1/catalog/us/artists/42", "/v1/me/library"]) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ data: [{ ...artist(), href }] }));
      await expect(
        createClient(new MemoryPersistence(), fetchImpl).getArtist("42"),
      ).resolves.toMatchObject({ artistId: "42" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
