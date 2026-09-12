import { describe, expect, it } from "vitest";
import {
  defaultSchedulerLimits,
  nextSpotifyRollingRequestCapacityAt,
  staggerSpotifyArtistsAcrossWindow,
  spotifySchedulerShortWindowMs,
  spotifySchedulerWindowMs,
} from "./spotify-scheduler";

describe("Spotify rolling scheduler planning", () => {
  it("uses the accepted one-artist, six-request, 90-second limits", () => {
    expect(defaultSchedulerLimits()).toEqual({
      artistAlbums24HourLimit: 80,
      artistAlbumsPriorityReserve: 20,
      artistAlbumsReserveReleaseAfterHours: 20,
      maxBroadArtistsPerLocalDay: 75,
      maxBroadRequestsPerLocalDay: 300,
      maxArtistsPerTick: 1,
      maxRequestsPerTick: 6,
      maxRuntimeMs: 90_000,
      minRequestIntervalMs: 10_000,
      rolling24HourLimit: 1_200,
      rolling30MinuteLimit: 30,
      playlistRequestReserve: 20,
      priorityRequestReserve: 200,
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

  it("reports the later return when both rolling request windows are exhausted", () => {
    const now = new Date("2026-09-12T10:00:00.000Z");
    const shortWindowStarts = Array.from(
      { length: 4 },
      (_, index) => new Date(now.getTime() - (20 - index) * 60_000),
    );
    const longWindowStarts = Array.from(
      { length: 6 },
      (_, index) => new Date(now.getTime() - (23 - index) * 60 * 60_000),
    );

    expect(
      nextSpotifyRollingRequestCapacityAt(
        [...longWindowStarts, ...shortWindowStarts],
        { rolling24HourLimit: 6, rolling30MinuteLimit: 4 },
        now,
      ),
    ).toEqual(new Date(longWindowStarts[4]!.getTime() + spotifySchedulerWindowMs));
  });

  it("returns the short-window capacity boundary and null when a request can start", () => {
    const now = new Date("2026-09-12T10:00:00.000Z");
    const starts = [
      new Date(now.getTime() - 20 * 60_000),
      new Date(now.getTime() - 10 * 60_000),
      new Date(now.getTime() - 5 * 60_000),
    ];
    const limits = { rolling24HourLimit: 100, rolling30MinuteLimit: 3 };

    expect(nextSpotifyRollingRequestCapacityAt(starts, limits, now)).toEqual(
      new Date(starts[0]!.getTime() + spotifySchedulerShortWindowMs),
    );
    expect(nextSpotifyRollingRequestCapacityAt(starts.slice(1), limits, now)).toBeNull();
  });
});
