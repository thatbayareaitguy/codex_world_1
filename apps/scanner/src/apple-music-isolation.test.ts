import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it } from "vitest";
import { runScanUnlocked } from "./scan";

describe("Apple Music production isolation", () => {
  it("cannot run through the production scanner or playlist pipeline", async () => {
    const configuration = loadProviderConfiguration({
      APPLE_MUSIC_ENABLED: "false",
      ITUNES_DISCOVERY_ENABLED: "false",
      MUSICBRAINZ_ENABLED: "false",
      REDDIT_ENABLED: "false",
      SOUNDCLOUD_MANUAL_LINKS_ENABLED: "false",
      SPOTIFY_ENABLED: "false",
      SPOTIFY_PLAYLIST_WRITES_ENABLED: "false",
    });
    await expect(
      runScanUnlocked(
        {
          dryRun: true,
          full: false,
          provider: "apple_music",
        },
        configuration,
      ),
    ).rejects.toThrow("excluded from the current milestone");
  });
});
