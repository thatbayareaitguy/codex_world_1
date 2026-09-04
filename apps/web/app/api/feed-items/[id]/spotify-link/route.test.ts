import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { end, limit, queueSpotifyTrackResolutionWork } = vi.hoisted(() => ({
  end: vi.fn(() => Promise.resolve()),
  limit: vi.fn(),
  queueSpotifyTrackResolutionWork: vi.fn(() => Promise.resolve()),
}));

vi.mock("@radar/db", () => {
  const table = new Proxy({}, { get: (_target, property) => String(property) });
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    limit,
    orderBy: vi.fn(() => query),
    where: vi.fn(() => query),
  };
  return {
    artistExternalIds: table,
    createDatabase: vi.fn(() => ({
      client: { end },
      db: { select: vi.fn(() => query) },
    })),
    feedItems: table,
    queueSpotifyTrackResolutionWork,
    trackCredits: table,
    tracks: table,
  };
});
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({
    databaseUrl: "postgres://synthetic",
    spotify: { scheduler: { enabled: true } },
  })),
}));
vi.mock("../../../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

import { POST } from "./route";

const feedItemId = "22222222-2222-4222-8222-222222222222";
const request = (url: string) =>
  new NextRequest(`http://127.0.0.1:3000/api/feed-items/${feedItemId}/spotify-link`, {
    body: JSON.stringify({ url }),
    headers: { "Content-Type": "application/json", origin: "http://127.0.0.1:3000" },
    method: "POST",
  });
const context = { params: Promise.resolve({ id: feedItemId }) };

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue([
    {
      artistId: "33333333-3333-4333-8333-333333333333",
      isrc: "CA5KR2665824",
      spotifyArtistId: "spotify-artist",
      trackId: "44444444-4444-4444-8444-444444444444",
    },
  ]);
});

describe("manual Spotify track resolution", () => {
  it("queues a safe track URL for scheduler verification without making a provider request", async () => {
    const response = await POST(
      request("https://open.spotify.com/track/0M6v8qTwT7wfiEsAmLQKdd?si=synthetic"),
      context,
    );

    expect(response.status).toBe(202);
    expect(queueSpotifyTrackResolutionWork).toHaveBeenCalledWith(expect.anything(), {
      artistId: "33333333-3333-4333-8333-333333333333",
      expectedSpotifyArtistId: "spotify-artist",
      mode: "manual",
      source: "repair",
      spotifyTrackId: "0M6v8qTwT7wfiEsAmLQKdd",
      targetIsrc: "CA5KR2665824",
      targetTrackId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("rejects lookalike hosts before touching the database", async () => {
    const response = await POST(
      request("https://open.spotify.example/track/0M6v8qTwT7wfiEsAmLQKdd"),
      context,
    );
    expect(response.status).toBe(400);
    expect(limit).not.toHaveBeenCalled();
    expect(queueSpotifyTrackResolutionWork).not.toHaveBeenCalled();
  });

  it("requires an ISRC so manual linking remains exact", async () => {
    limit.mockResolvedValueOnce([
      {
        artistId: "33333333-3333-4333-8333-333333333333",
        isrc: null,
        spotifyArtistId: "spotify-artist",
        trackId: "44444444-4444-4444-8444-444444444444",
      },
    ]);
    const response = await POST(
      request("https://open.spotify.com/track/0M6v8qTwT7wfiEsAmLQKdd"),
      context,
    );
    expect(response.status).toBe(409);
    expect(queueSpotifyTrackResolutionWork).not.toHaveBeenCalled();
  });
});
