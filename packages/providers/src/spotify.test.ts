import { describe, expect, it, vi } from "vitest";
import { SpotifyClient, SpotifyHttpError, SpotifyOAuthClient } from "./spotify";

const artist = (id: string, name = `Artist ${id}`) => ({
  external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
  id,
  images: [],
  name,
  type: "artist",
  uri: `spotify:artist:${id}`,
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

  it("honors Retry-After exactly for 429 responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(jsonResponse(artist("artist-1")));
    const sleep = vi.fn(() => Promise.resolve());
    const client = new SpotifyClient({
      accessToken: () => Promise.resolve("token"),
      fetcher,
      sleep,
    });

    await client.getArtist("artist-1");
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(client.metrics.rateLimitWaitMs).toBe(2_000);
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

  it("batches playlist additions at the current 100 item maximum", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "one" }, 201))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "two" }, 201))
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: "three" }, 201));
    const client = new SpotifyClient({ accessToken: () => Promise.resolve("token"), fetcher });

    const snapshots = await client.addPlaylistItems(
      "playlist",
      Array.from({ length: 205 }, (_, index) => `track-${index}`),
    );
    expect(snapshots).toEqual(["one", "two", "three"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("SpotifyOAuthClient", () => {
  it("uses Authorization Code with PKCE and preserves refresh-token rotation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "rotated-refresh",
        scope: "user-follow-read playlist-read-private playlist-modify-private",
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
    expect(authorization.searchParams.get("scope")).not.toContain("streaming");
    await expect(client.refresh("refresh")).resolves.toMatchObject({
      refresh_token: "rotated-refresh",
    });
  });
});
