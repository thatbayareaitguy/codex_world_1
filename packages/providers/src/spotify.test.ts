import { describe, expect, it, vi } from "vitest";
import {
  hasSpotifyPlaylistWriteScopes,
  inspectSpotifyErrorResponse,
  parseSpotifyRetryAfter,
  spotifyArtistAlbumsSchema,
  spotifyEndpointCategory,
  spotifyNextOffset,
  SpotifyClient,
  SpotifyHttpError,
  SpotifyOAuthClient,
  type SpotifyRequestGate,
} from "./spotify";

const artist = (id: string, name = `Artist ${id}`) => ({
  external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
  id,
  images: [],
  name,
  type: "artist",
  uri: `spotify:artist:${id}`,
});

const profile = {
  account_id: "account-owner",
  display_name: "Synthetic Owner",
  external_urls: { spotify: "https://open.spotify.com/user/synthetic" },
  id: "user-owner",
  type: "user",
  uri: "spotify:user:synthetic",
} as const;

const playlist = (overrides: Record<string, unknown> = {}) => ({
  collaborative: false,
  external_urls: { spotify: "https://open.spotify.com/playlist/1234567890123456789012" },
  id: "1234567890123456789012",
  name: "Release Inbox",
  owner: { account_id: "account-owner", id: "user-owner" },
  public: false,
  snapshot_id: "snapshot",
  uri: "spotify:playlist:1234567890123456789012",
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("Spotify pagination cursors", () => {
  it("uses the provider next URL instead of the number of returned items", () => {
    expect(
      spotifyNextOffset("https://api.spotify.com/v1/artists/artist/albums?limit=10&offset=100", 90),
    ).toBe(100);
  });

  it("rejects missing, stale, and malformed next offsets", () => {
    expect(spotifyNextOffset(null, 90)).toBeNull();
    expect(() =>
      spotifyNextOffset("https://api.spotify.com/v1/artists/artist/albums?offset=90", 90),
    ).toThrow("invalid next-page offset");
    expect(() =>
      spotifyNextOffset("https://api.spotify.com/v1/artists/artist/albums?offset=nope", 90),
    ).toThrow("invalid next-page offset");
  });
});

describe("Spotify endpoint quota categories", () => {
  it.each([
    ["/artists/artist/albums?limit=10", "GET", "artist_albums"],
    ["/albums/album", "GET", "album_detail"],
    ["/albums/album/tracks", "GET", "album_tracks"],
    ["/playlists/playlist", "GET", "playlist_read"],
    ["/playlists/playlist", "PUT", "playlist_write"],
    ["/playlists/playlist/items", "GET", "playlist_read"],
    ["/playlists/playlist/items", "POST", "playlist_write"],
    ["/playlists/playlist/items", "PUT", "playlist_write"],
    ["/me", "GET", "oauth_or_other"],
  ])("classifies %s %s as %s", (path, method, expected) => {
    expect(spotifyEndpointCategory(path, method)).toBe(expected);
  });
});

describe("Spotify 429 response evidence", () => {
  it("recognizes only the documented QUOTA_EXCEEDED reason location", async () => {
    await expect(
      inspectSpotifyErrorResponse(
        jsonResponse(
          { error: { message: "quota reached", reason: "QUOTA_EXCEEDED", status: 429 } },
          429,
        ),
      ),
    ).resolves.toEqual({
      providerErrorClassification: "quota_exceeded",
      providerReasonToken: "QUOTA_EXCEEDED",
      rateLimit: {
        classification: "quota_exceeded",
        providerReasonToken: "QUOTA_EXCEEDED",
      },
      responseClassification: "json_error",
    });

    await expect(
      inspectSpotifyErrorResponse(
        jsonResponse({ error: { details: { reason: "QUOTA_EXCEEDED" } } }, 429),
      ),
    ).resolves.toEqual({
      rateLimit: { classification: "unspecified_429" },
      responseClassification: "json_error",
    });
  });

  it.each([
    ["missing reason", { error: { message: "rate limited" } }, "json_error"],
    ["unexpected shape", { reason: "QUOTA_EXCEEDED" }, "json_other"],
  ])("classifies %s as unspecified", async (_name, body, responseClassification) => {
    await expect(inspectSpotifyErrorResponse(jsonResponse(body, 429))).resolves.toEqual({
      rateLimit: { classification: "unspecified_429" },
      responseClassification,
    });
  });

  it("retains only bounded safe unknown reason tokens", async () => {
    await expect(
      inspectSpotifyErrorResponse(jsonResponse({ error: { reason: "NEW_LIMIT_REASON_2" } }, 429)),
    ).resolves.toMatchObject({
      providerReasonToken: "NEW_LIMIT_REASON_2",
      rateLimit: {
        classification: "unknown_reason",
        providerReasonToken: "NEW_LIMIT_REASON_2",
      },
    });

    for (const reason of ["unsafe reason: account text", "A".repeat(65)]) {
      await expect(
        inspectSpotifyErrorResponse(jsonResponse({ error: { reason } }, 429)),
      ).resolves.toMatchObject({
        rateLimit: { classification: "unknown_reason" },
      });
      expect(
        (await inspectSpotifyErrorResponse(jsonResponse({ error: { reason } }, 429))).rateLimit,
      ).not.toHaveProperty("providerReasonToken");
    }
  });

  it.each([
    ["empty", new Response("", { status: 429 }), "empty"],
    ["malformed", new Response("{", { status: 429 }), "non_json"],
    ["html", new Response("<html>limited</html>", { status: 429 }), "non_json"],
    [
      "oversized",
      new Response("x".repeat(4_097), {
        headers: { "content-type": "text/plain" },
        status: 429,
      }),
      "oversized",
    ],
  ])("handles an %s 429 body without retaining it", async (_name, response, classification) => {
    await expect(inspectSpotifyErrorResponse(response)).resolves.toEqual({
      rateLimit: { classification: "unspecified_429" },
      responseClassification: classification,
    });
  });

  it("treats response-body read failures as unspecified", async () => {
    const response = new Response("", { status: 429 });
    Object.defineProperty(response, "clone", {
      value: () => {
        throw new Error("synthetic body read failure with sensitive text");
      },
    });
    await expect(inspectSpotifyErrorResponse(response)).resolves.toEqual({
      rateLimit: { classification: "unspecified_429" },
      responseClassification: "unreadable",
    });
  });

  it("retains a safe reason token without misclassifying a non-429 response", async () => {
    await expect(
      inspectSpotifyErrorResponse(jsonResponse({ error: { reason: "QUOTA_EXCEEDED" } }, 403)),
    ).resolves.toEqual({
      providerErrorClassification: "quota_exceeded",
      providerReasonToken: "QUOTA_EXCEEDED",
      responseClassification: "json_error",
    });
  });

  it.each([
    ["Insufficient client scope", "insufficient_scope"],
    ["Quota exceeded", "quota_exceeded"],
    ["Premium required", "premium_required"],
    ["Restriction violated", "restriction_violated"],
    ["Forbidden.", "forbidden"],
  ])("classifies a known safe provider message without retaining it", async (message, expected) => {
    await expect(
      inspectSpotifyErrorResponse(jsonResponse({ error: { message } }, 403)),
    ).resolves.toEqual({
      providerErrorClassification: expected,
      responseClassification: "json_error",
    });
  });

  it("does not retain unsafe reason text from a non-429 response", async () => {
    await expect(
      inspectSpotifyErrorResponse(
        jsonResponse({ error: { reason: "unsafe account-specific reason" } }, 403),
      ),
    ).resolves.toEqual({ responseClassification: "json_error" });
  });
});

describe("SpotifyClient", () => {
  it("uses an explicit bounded album-track page size", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        href: "https://api.spotify.com/v1/albums/album/tracks?limit=10&offset=10",
        items: [],
        limit: 10,
        next: null,
        offset: 10,
        previous: null,
        total: 23,
      }),
    );
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
    });

    await client.getAlbumTracksPage("album", 10, undefined, 10);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/albums/album/tracks?limit=10&offset=10",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([0, 51, 1.5])("rejects invalid album-track page size %s", async (limit) => {
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token") });
    await expect(client.getAlbumTracksPage("album", 0, undefined, limit)).rejects.toThrow(
      "integer from 1 to 50",
    );
  });

  it("keeps safe album artwork and ignores absent, malformed, or unsafe image entries", () => {
    const page = {
      href: "https://api.spotify.com/v1/artists/artist/albums",
      items: [
        {
          album_type: "single",
          artists: [artist("artist")],
          external_urls: { spotify: "https://open.spotify.com/album/album" },
          id: "album",
          images: [
            { height: 300, url: "https://i.scdn.co/image/safe", width: 300 },
            { height: 640, url: "https://example.com/unsafe", width: 640 },
            { height: "bad", url: "https://i.scdn.co/image/malformed", width: 64 },
            {
              embeddedPayload: "must-not-survive",
              height: 300,
              url: "https://i.scdn.co/image/stripped",
              width: 300,
            },
          ],
          name: "Album",
          release_date: "2026-07-20",
          release_date_precision: "day",
          total_tracks: 1,
          type: "album",
          uri: "spotify:album:album",
        },
        {
          album_type: "album",
          artists: [artist("artist")],
          external_urls: { spotify: "https://open.spotify.com/album/no-art" },
          id: "no-art",
          name: "No artwork",
          release_date: "2026",
          release_date_precision: "year",
          total_tracks: 1,
          type: "album",
          uri: "spotify:album:no-art",
        },
        {
          album_type: "single",
          artists: [artist("artist")],
          external_urls: { spotify: "https://open.spotify.com/album/malformed-art" },
          id: "malformed-art",
          images: "not-an-array",
          name: "Malformed artwork",
          release_date: "2026-07",
          release_date_precision: "month",
          total_tracks: 1,
          type: "album",
          uri: "spotify:album:malformed-art",
        },
      ],
      limit: 10,
      next: null,
      offset: 0,
      previous: null,
      total: 3,
    };
    const parsed = spotifyArtistAlbumsSchema.parse(page);

    expect(parsed.items[0]?.images).toEqual([
      { height: 300, url: "https://i.scdn.co/image/safe", width: 300 },
      { height: 300, url: "https://i.scdn.co/image/stripped", width: 300 },
    ]);
    expect(parsed.items[1]?.images).toEqual([]);
    expect(parsed.items[2]?.images).toEqual([]);
  });

  it("validates profile responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        display_name: "Synthetic Owner",
        external_urls: { spotify: "https://open.spotify.com/user/synthetic" },
        id: "mutable-id",
        type: "user",
        uri: "spotify:user:synthetic",
      }),
    );
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token"), fetcher });

    await expect(client.getCurrentUser()).rejects.toMatchObject({ name: "ZodError" });
  });

  it("follows every cursor page for followed artists", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          artists: {
            cursors: { after: "artist-1" },
            href: "https://api.spotify.test/page/1",
            items: [artist("artist-1")],
            limit: 50,
            next: "https://api.spotify.test/page/2",
            total: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          artists: {
            cursors: { after: null },
            href: "https://api.spotify.test/page/2",
            items: [artist("artist-2")],
            limit: 50,
            next: null,
            total: 2,
          },
        }),
      );
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token"), fetcher });

    await expect(client.getFollowedArtists()).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toEqual(expect.stringContaining("after=artist-1"));
  });

  it("refreshes once after a 401", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse(artist("artist-1")));
    const onUnauthorized = vi.fn(() => Promise.resolve());
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      onUnauthorized,
    });

    await expect(client.getArtist("artist-1")).resolves.toMatchObject({ id: "artist-1" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("records Retry-After and stops immediately after a 429", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { message: "rate limited" } }, 429, { "Retry-After": "2" }),
      );
    const complete = vi.fn().mockResolvedValue(undefined);
    const requestGate: SpotifyRequestGate = {
      acquire: vi.fn().mockResolvedValue({
        eventId: "event",
        leaseToken: "lease",
        queueLength: 0,
        queueWaitMs: 0,
        startedAt: new Date("2026-07-17T00:00:00Z"),
      }),
      complete,
    };
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      requestGate,
    });

    await expect(client.getArtist("artist-1")).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event" }),
      expect.objectContaining({
        errorClassification: "rate_limited_integer_seconds",
        parsedRetryAfterSeconds: "2",
        rateLimitClassification: "unspecified_429",
        rawRetryAfter: "2",
        status: 429,
      }),
    );
    expect(JSON.stringify(complete.mock.calls)).not.toContain("rate limited");
  });

  it("resolves a possibly refreshing token before acquiring an API request permit", async () => {
    const order: string[] = [];
    const requestGate: SpotifyRequestGate = {
      acquire: vi.fn(() => {
        order.push("permit");
        return Promise.resolve({
          eventId: "event",
          leaseToken: "lease",
          queueLength: 0,
          queueWaitMs: 0,
          startedAt: new Date("2026-07-21T00:00:00Z"),
        });
      }),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const client = new SpotifyClient({
      accessToken: () => {
        order.push("token");
        return Promise.resolve("token");
      },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(artist("artist-1"))),
      requestGate,
    });

    await client.getArtist("artist-1");
    expect(order).toEqual(["token", "permit"]);
  });

  it("reports request telemetry without exposing authorization data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(artist("artist-1")));
    const onTelemetry = vi.fn(() => Promise.resolve());
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("sensitive-token"),
      fetcher,
      onTelemetry,
    });

    await client.getArtist("artist-1");

    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "request", requests: 1 }),
    );
    expect(JSON.stringify(onTelemetry.mock.calls)).not.toContain("sensitive-token");
  });

  it("retries transient failures and does not retry permanent failures", async () => {
    const transientFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(artist("artist-1")));
    const sleep = vi.fn(() => Promise.resolve());
    const transient = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher: transientFetch,
      random: () => 0,
      sleep,
    });
    await expect(transient.getArtist("artist-1")).resolves.toMatchObject({ id: "artist-1" });
    expect(sleep).toHaveBeenCalledOnce();

    const permanentFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 403));
    const permanent = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher: permanentFetch,
    });
    await expect(permanent.getArtist("artist-1")).rejects.toBeInstanceOf(SpotifyHttpError);
    expect(permanentFetch).toHaveBeenCalledOnce();

    const classifiedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { reason: "QUOTA_EXCEEDED" } }, 403));
    const classified = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher: classifiedFetch,
    });
    await expect(classified.getArtist("artist-1")).rejects.toMatchObject({
      providerErrorClassification: "quota_exceeded",
      providerReasonToken: "QUOTA_EXCEEDED",
      status: 403,
    });
  });

  it("rejects playlist additions before any request when writes are disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token"), fetcher });

    await expect(
      client.addPlaylistItems("1234567890123456789012", ["0000000000000000000001"]),
    ).rejects.toMatchObject({ code: "writes_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects every playlist ID except the configured target", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.addPlaylistItems("abcdefghijklmnopqrstuv", ["0000000000000000000001"]),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    await expect(
      client.addPlaylistItems("invalid", ["0000000000000000000001"]),
    ).rejects.toMatchObject({ code: "playlist_id_malformed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies ownership and non-collaboration before batching public-playlist additions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(playlist({ public: true })))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "one" }, 201))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "two" }, 201))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "three" }, 201));
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    const snapshots = await client.addPlaylistItems(
      "1234567890123456789012",
      Array.from({ length: 205 }, (_, index) => String(index).padStart(22, "0")),
    );
    expect(snapshots).toEqual(["one", "two", "three"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining("/playlists/1234567890123456789012/items"),
    );
  });

  it("adds one bounded ordered batch at the configured position", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(playlist()))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "positioned" }, 201));
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.addPlaylistItemsAtPosition(
        "1234567890123456789012",
        ["0000000000000000000001", "0000000000000000000002"],
        7,
      ),
    ).resolves.toBe("positioned");
    const request = fetcher.mock.calls[2]?.[1];
    expect(request?.method).toBe("POST");
    expect(typeof request?.body).toBe("string");
    expect(JSON.parse(request?.body as string)).toEqual({
      position: 7,
      uris: ["spotify:track:0000000000000000000001", "spotify:track:0000000000000000000002"],
    });
  });

  it("reorders one bounded range only within the configured playlist", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ snapshot_id: "reordered" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.reorderPlaylistItems("1234567890123456789012", {
        insertBefore: 2,
        rangeLength: 3,
        rangeStart: 8,
        snapshotId: "before",
      }),
    ).resolves.toBe("reordered");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/playlists/1234567890123456789012/items"),
      expect.objectContaining({
        body: JSON.stringify({
          insert_before: 2,
          range_length: 3,
          range_start: 8,
          snapshot_id: "before",
        }),
        method: "PUT",
      }),
    );

    fetcher.mockClear();
    await expect(
      client.reorderPlaylistItems("abcdefghijklmnopqrstuv", {
        insertBefore: 0,
        rangeLength: 1,
        rangeStart: 1,
        snapshotId: "before",
      }),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("makes only the configured owned playlist public and non-collaborative", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(playlist()))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.setAuthorizedPlaylistPublic("1234567890123456789012"),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining("/playlists/1234567890123456789012"),
    );
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ collaborative: false, public: true }),
      method: "PUT",
    });

    fetcher.mockClear();
    await expect(
      client.setAuthorizedPlaylistPublic("abcdefghijklmnopqrstuv"),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects positional additions before any request when the target or batch is invalid", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.addPlaylistItemsAtPosition("abcdefghijklmnopqrstuv", ["0000000000000000000001"], 0),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    await expect(
      client.addPlaylistItemsAtPosition("1234567890123456789012", [], 0),
    ).rejects.toMatchObject({ code: "playlist_addition_invalid" });
    await expect(
      client.addPlaylistItemsAtPosition("1234567890123456789012", ["0000000000000000000001"], -1),
    ).rejects.toThrow("nonnegative integer");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["another owner", playlist({ owner: { account_id: "someone-else" } }), "playlist_not_owned"],
    ["a collaborative playlist", playlist({ collaborative: true }), "playlist_collaborative"],
  ])("rejects %s before posting items", async (_label, playlistResponse, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(playlistResponse));
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      playlistWritePolicy: {
        allowedPlaylistId: "1234567890123456789012",
        enabled: true,
      },
    });

    await expect(
      client.addPlaylistItems("1234567890123456789012", ["0000000000000000000001"]),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not expose prohibited playlist-write methods", () => {
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token") });
    const surface = client as unknown as Record<string, unknown>;
    for (const method of [
      "createPrivatePlaylist",
      "removePlaylistItems",
      "replacePlaylistItems",
      "renamePlaylist",
      "changePlaylistVisibility",
      "uploadPlaylistCover",
      "followPlaylist",
      "unfollowPlaylist",
    ]) {
      expect(surface[method], method).toBeUndefined();
    }
  });
});

describe("SpotifyOAuthClient", () => {
  it("uses Authorization Code with PKCE and preserves refresh-token rotation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "rotated-refresh",
        scope: "user-follow-read playlist-read-private",
        token_type: "Bearer",
      }),
    );
    const client = new SpotifyOAuthClient({
      accountsBaseUrl: "https://accounts.spotify.test",
      clientId: "client",
      clientSecret: "secret",
      fetcher,
      redirectUri: "http://127.0.0.1:3000/api/auth/spotify/callback",
    });
    const authorization = new URL(client.authorizationUrl("state", "challenge"));

    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
      "user-follow-read",
      "playlist-read-private",
    ]);
    expect(authorization.searchParams.get("scope")).not.toContain("playlist-modify");
    expect(authorization.searchParams.has("show_dialog")).toBe(false);
    await expect(client.refresh("refresh")).resolves.toMatchObject({
      refresh_token: "rotated-refresh",
    });
  });

  it("forces renewed consent with both playlist modification scopes when additions are enabled", () => {
    const client = new SpotifyOAuthClient({
      clientId: "client",
      clientSecret: "secret",
      playlistWritesEnabled: true,
      redirectUri: "http://127.0.0.1:3000/api/auth/spotify/callback",
    });
    const authorization = new URL(client.authorizationUrl("state", "challenge"));

    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
      "user-follow-read",
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
    ]);
    expect(authorization.searchParams.get("show_dialog")).toBe("true");
  });

  it("requires both playlist modification scopes for write authorization", () => {
    expect(hasSpotifyPlaylistWriteScopes(["playlist-modify-private"])).toBe(false);
    expect(hasSpotifyPlaylistWriteScopes(["playlist-modify-public"])).toBe(false);
    expect(
      hasSpotifyPlaylistWriteScopes(["playlist-modify-private", "playlist-modify-public"]),
    ).toBe(true);
  });
});

describe("parseSpotifyRetryAfter", () => {
  const observedAt = new Date("2026-07-17T00:00:00.000Z");

  it.each([
    ["47", 47_000, "47"],
    ["0", 0, "0"],
    ["5000", 5_000_000, "5000"],
  ])("interprets %s as integer seconds", (raw, waitMs, parsedSeconds) => {
    expect(parseSpotifyRetryAfter(raw, observedAt)).toMatchObject({
      cooldownIndefinite: false,
      interpretation: "integer_seconds",
      parsedSeconds,
      rawValue: raw,
      waitMs,
    });
  });

  it.each([
    [null, "missing"],
    ["", "missing"],
    ["not-a-duration", "malformed"],
    ["Wed, 21 Oct 2030 07:28:00 GMT", "http_date"],
  ] as const)("uses a bounded fallback for %s", (raw, interpretation) => {
    expect(parseSpotifyRetryAfter(raw, observedAt)).toMatchObject({
      cooldownIndefinite: false,
      interpretation,
      waitMs: 60_000,
    });
  });

  it.each(["31536001", "999999999999999999999999999999"])(
    "blocks indefinitely when %s exceeds the maximum wait",
    (raw) => {
      expect(parseSpotifyRetryAfter(raw, observedAt)).toMatchObject({
        cooldownIndefinite: true,
        interpretation: "overflow",
        rawValue: raw,
      });
    },
  );
});
