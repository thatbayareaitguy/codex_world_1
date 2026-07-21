import { describe, expect, it } from "vitest";
import { selectSpotifyReconciliationMappings, spotifyScheduleEstimate } from "./spotify-scan-plan";
import { spotifyBatchPauseMilliseconds, spotifyReleaseTelemetry } from "./scan";

describe("Spotify scan scheduling", () => {
  it("adds bounded jitter to the configured batch pause", () => {
    expect(spotifyBatchPauseMilliseconds(60, () => 0)).toBe(60_000);
    expect(spotifyBatchPauseMilliseconds(60, () => 0.999_999)).toBeGreaterThanOrEqual(69_999);
    expect(spotifyBatchPauseMilliseconds(60, () => 1)).toBeLessThan(70_000);
  });

  it("distributes a 593-artist daily plan over 24 hours", () => {
    const estimate = spotifyScheduleEstimate(593, {
      spotify: {
        dailyMaxPagesPerArtist: 1,
        minRequestIntervalMs: 5_000,
        scanDistributionHours: 24,
      },
    } as Parameters<typeof spotifyScheduleEstimate>[1]);
    expect(estimate.artistsPerHour).toBeCloseTo(24.708, 3);
    expect(estimate.estimatedMaximumRequests).toBe(6_523);
    expect(estimate.estimatedMinimumHours).toBeGreaterThanOrEqual(24);
  });

  it("summarizes returned and backfill-eligible releases for persisted artist telemetry", () => {
    expect(spotifyReleaseTelemetry(undefined)).toEqual({});
    expect(
      spotifyReleaseTelemetry([
        { backfillEligible: true },
        { backfillEligible: false },
        { backfillEligible: true },
      ] as Parameters<typeof spotifyReleaseTelemetry>[0]),
    ).toEqual({ backfillReleaseCount: 2, releaseCount: 3 });
  });
});

describe("selectSpotifyReconciliationMappings", () => {
  const mappings = ["missing", "partial", "recent", "expired"].map((artistId) => ({
    artistId,
    name: artistId,
    spotifyArtistId: `spotify-${artistId}`,
  }));

  it("selects incomplete and expired artists without reopening a current full cycle", () => {
    const selected = selectSpotifyReconciliationMappings(
      mappings,
      [
        {
          artistId: "partial",
          lastFullReconciliationAt: null,
          partial: true,
          status: "reconciliation_queued",
        },
        {
          artistId: "recent",
          lastFullReconciliationAt: new Date("2026-07-15T00:00:00.000Z"),
          partial: false,
          status: "fully_reconciled",
        },
        {
          artistId: "expired",
          lastFullReconciliationAt: new Date("2026-05-01T00:00:00.000Z"),
          partial: false,
          status: "fully_reconciled",
        },
      ],
      30,
      new Date("2026-07-21T00:00:00.000Z"),
    );

    expect(selected.map((mapping) => mapping.artistId)).toEqual(["missing", "partial", "expired"]);
  });
});
