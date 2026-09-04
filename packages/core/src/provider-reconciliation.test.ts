import { describe, expect, it } from "vitest";
import {
  reconcileProviderReleases,
  type ProviderReleaseReconciliationObservation,
} from "./provider-reconciliation";

describe("provider release reconciliation", () => {
  it("matches independently ingested releases that resolve to one canonical release", () => {
    const results = reconcileProviderReleases([
      release("apple_music", "apple-release", "canonical-release", ["canonical-track"]),
      release("spotify", "spotify-release", "canonical-release", ["canonical-track"], true),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      matchedTrackCount: 1,
      missingSpotifyTrackCount: 0,
      playlistEligible: true,
      playlistEligibleTrackCount: 1,
      status: "matched",
    });
  });

  it("reports Apple tracks that have no independently ingested Spotify match", () => {
    const results = reconcileProviderReleases([
      release("apple_music", "apple-release", "canonical-release", ["track-1", "track-2"]),
      release("spotify", "spotify-release", "canonical-release", ["track-1"], true),
    ]);

    expect(results[0]).toMatchObject({
      matchedTrackCount: 1,
      missingSpotifyTrackCount: 1,
      status: "missing_spotify_track",
    });
  });

  it("preserves ambiguity when multiple Spotify releases have comparable evidence", () => {
    const apple = release("apple_music", "apple-release", null, [null]);
    const spotifyOne = release("spotify", "spotify-one", null, [null]);
    const spotifyTwo = release("spotify", "spotify-two", null, [null]);

    const results = reconcileProviderReleases([apple, spotifyOne, spotifyTwo]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "uncertain")).toBe(true);
    expect(results.map((result) => result.spotifyProviderReleaseId).sort()).toEqual([
      "spotify-one",
      "spotify-two",
    ]);
    expect(results[0]?.reasons).toContain(
      "Multiple Spotify releases have comparable evidence; each candidate is preserved for review.",
    );
  });

  it("preserves reverse ambiguity when multiple Apple releases point to one Spotify release", () => {
    const appleOne = release("apple_music", "apple-one", null, [null]);
    const appleTwo = release("apple_music", "apple-two", null, [null]);
    const spotify = release("spotify", "spotify-release", null, [null]);

    const results = reconcileProviderReleases([appleOne, appleTwo, spotify]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "uncertain")).toBe(true);
    expect(results.map((result) => result.appleProviderReleaseId).sort()).toEqual([
      "apple-one",
      "apple-two",
    ]);
    expect(results[0]?.reasons).toContain(
      "Multiple Apple releases have comparable evidence; each candidate is preserved for review.",
    );
  });

  it("does not force a match when a shared canonical release has contradictory metadata", () => {
    const apple = release("apple_music", "apple-release", "canonical-release", ["track-1"]);
    const spotify = {
      ...release("spotify", "spotify-release", "canonical-release", ["track-1"], true),
      releaseDate: "2026-07-01",
    };

    const [result] = reconcileProviderReleases([apple, spotify]);

    expect(result).toMatchObject({ status: "uncertain" });
    expect(result?.reasons).toContain("Release dates conflict.");
  });

  it("keeps unmatched releases provider-specific", () => {
    const apple = release("apple_music", "apple-release", null, ["apple-track"]);
    const spotify = {
      ...release("spotify", "spotify-release", null, ["spotify-track"]),
      releaseDate: "2026-06-01",
      title: "Different title",
    };

    const results = reconcileProviderReleases([apple, spotify]);

    expect(results.map((result) => result.status).sort()).toEqual(["apple_only", "spotify_only"]);
    expect(results.find((result) => result.status === "apple_only")).toMatchObject({
      missingSpotifyTrackCount: 0,
      playlistEligible: false,
    });
  });

  it("is deterministic when provider observations arrive in a different order", () => {
    const observations = [
      release("spotify", "spotify-two", null, [null]),
      release("apple_music", "apple-release", null, [null]),
      release("spotify", "spotify-one", null, [null]),
    ];

    expect(reconcileProviderReleases(observations)).toEqual(
      reconcileProviderReleases([...observations].reverse()),
    );
  });
});

function release(
  provider: "apple_music" | "spotify",
  providerReleaseId: string,
  canonicalReleaseId: string | null,
  trackIds: Array<string | null>,
  playlistEligible = false,
): ProviderReleaseReconciliationObservation {
  return {
    canonicalReleaseId,
    provider,
    providerReleaseId,
    releaseDate: "2026-08-01",
    releaseType: "single",
    title: "Signal",
    tracks: trackIds.map((canonicalTrackId, index) => ({
      canonicalTrackId,
      discNumber: 1,
      normalizedTitle: `track ${index + 1}`,
      playlistEligible,
      providerTrackId: `${provider}-track-${index + 1}`,
      trackNumber: index + 1,
    })),
  };
}
