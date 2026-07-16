import { describe, expect, it } from "vitest";
import { planSpotifyPlaylistSync } from "./spotify-playlist";

describe("Spotify playlist planning", () => {
  it("deduplicates exact matches and rejects ambiguous tracks", () => {
    const plan = planSpotifyPlaylistSync(
      [
        {
          confidence: 1,
          manuallyConfirmed: false,
          matchRule: "exact_isrc",
          providerTrackId: "exact",
          providerUrl: "https://open.spotify.com/track/exact",
        },
        {
          confidence: 1,
          manuallyConfirmed: false,
          matchRule: "exact_isrc",
          providerTrackId: "exact",
          providerUrl: "https://open.spotify.com/track/exact",
        },
        {
          confidence: 0.8,
          manuallyConfirmed: false,
          matchRule: "metadata",
          providerTrackId: "ambiguous",
          providerUrl: "https://open.spotify.com/track/ambiguous",
        },
        {
          confidence: 0.8,
          manuallyConfirmed: true,
          matchRule: "manual_review",
          providerTrackId: "confirmed",
          providerUrl: "https://open.spotify.com/track/confirmed",
        },
      ],
      new Set(["exact"]),
    );

    expect(plan).toEqual({
      alreadyPresent: ["exact"],
      rejected: [
        {
          providerTrackId: "ambiguous",
          reason: "Only exact or manually confirmed matches may be exported",
        },
      ],
      toAdd: ["confirmed"],
    });
  });
});
