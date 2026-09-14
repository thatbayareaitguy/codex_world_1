import { describe, expect, it } from "vitest";
import { parseSpotifyLiveSmokeOptions, runSpotifyLiveSmoke } from "./spotify-live-smoke";

describe("Spotify live smoke safeguards", () => {
  it("defaults to refusal instead of making a live request", () => {
    expect(() => parseSpotifyLiveSmokeOptions([])).toThrow("Choose --dry-run");
  });

  it("accepts explicit read-only mode", () => {
    expect(parseSpotifyLiveSmokeOptions(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("rejects every former playlist-write option", () => {
    expect(() => parseSpotifyLiveSmokeOptions(["--playlist-write"])).toThrow(
      "Unknown live smoke option",
    );
    expect(() => parseSpotifyLiveSmokeOptions(["--confirm-temporary-playlist"])).toThrow(
      "Unknown live smoke option",
    );
  });

  it("refuses incomplete configuration before connecting", async () => {
    await expect(
      runSpotifyLiveSmoke(parseSpotifyLiveSmokeOptions(["--dry-run"]), {
        SPOTIFY_ENABLED: "true",
      }),
    ).rejects.toThrow("requires DATABASE_URL");
  });
});
