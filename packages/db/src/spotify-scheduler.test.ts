import { describe, expect, it } from "vitest";
import {
  defaultSchedulerLimits,
  staggerSpotifyArtistsAcrossWindow,
  spotifySchedulerWindowMs,
} from "./spotify-scheduler";

describe("Spotify rolling scheduler planning", () => {
  it("uses the accepted one-artist, six-request, 90-second limits", () => {
    expect(defaultSchedulerLimits()).toEqual({
      maxArtistsPerTick: 1,
      maxRequestsPerTick: 6,
      maxRuntimeMs: 90_000,
      minRequestIntervalMs: 10_000,
      rolling24HourLimit: 1_200,
      rolling30MinuteLimit: 30,
      windowHours: 24,
    });
  });

  it("stably spreads the current watchlist shape across one rolling day", () => {
    const now = new Date("2026-07-22T00:00:00.000Z");
    const artists = Array.from({ length: 593 }, (_, index) => ({
      artistId: `artist-${String(592 - index).padStart(3, "0")}`,
      followedAt: new Date(now.getTime() + (index % 11) * 1_000),
    }));

    const first = staggerSpotifyArtistsAcrossWindow(artists, now);
    const second = staggerSpotifyArtistsAcrossWindow([...artists].reverse(), now);

    expect(second).toEqual(first);
    expect(first).toHaveLength(593);
    expect(new Set(first.map((artist) => artist.artistId)).size).toBe(593);
    expect(first[0]!.dueAt).toEqual(now);
    expect(first.at(-1)!.dueAt.getTime()).toBeLessThan(now.getTime() + spotifySchedulerWindowMs);
    const intervals = first.slice(1).map((artist, index) => {
      return artist.dueAt.getTime() - first[index]!.dueAt.getTime();
    });
    expect(Math.min(...intervals)).toBeGreaterThanOrEqual(145_000);
    expect(Math.max(...intervals)).toBeLessThanOrEqual(146_000);
  });
});
