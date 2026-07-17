import { describe, expect, it } from "vitest";
import { parseSpotifyLiveSmokeOptions, runSpotifyLiveSmoke } from "./spotify-live-smoke";

describe("Spotify live smoke safeguards", () => {
  it("defaults to refusal instead of making a live request", () => {
    expect(() => parseSpotifyLiveSmokeOptions([])).toThrow("Choose --dry-run");
  });

  it("accepts explicit read-only mode", () => {
    expect(parseSpotifyLiveSmokeOptions(["--dry-run"])).toEqual({
      confirmTemporaryPlaylist: false,
      dryRun: true,
      playlistWrite: false,
    });
  });

  it("requires explicit playlist confirmation", () => {
    expect(() => parseSpotifyLiveSmokeOptions(["--playlist-write"])).toThrow(
      "--confirm-temporary-playlist",
    );
  });

  it("rejects conflicting modes", () => {
    expect(() =>
      parseSpotifyLiveSmokeOptions([
        "--dry-run",
        "--playlist-write",
        "--confirm-temporary-playlist",
      ]),
    ).toThrow("not both");
  });

  it("refuses incomplete configuration before connecting", async () => {
    await expect(
      runSpotifyLiveSmoke(parseSpotifyLiveSmokeOptions(["--dry-run"]), {
        SPOTIFY_ENABLED: "true",
      }),
    ).rejects.toThrow("requires DATABASE_URL");
  });
});
