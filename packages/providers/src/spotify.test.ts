import { describe, expect, it, vi } from "vitest";
import {
  parseSpotifyRetryAfter,
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

describe("SpotifyClient", () => {
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
        rawRetryAfter: "2",
        status: 429,
      }),
    );
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

  it("verifies ownership and privacy before batching additions at 100 items", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(playlist()))
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

  it.each([
    ["another owner", playlist({ owner: { account_id: "someone-else" } }), "playlist_not_owned"],
    ["a public playlist", playlist({ public: true }), "playlist_not_private"],
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
      "reorderPlaylistItems",
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
    await expect(client.refresh("refresh")).resolves.toMatchObject({
      refresh_token: "rotated-refresh",
    });
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
