import { describe, expect, it } from "vitest";
import { spotifyArtistWorkScanOptions } from "./spotify-scheduler-cli";

describe("Spotify scheduler artist scan options", () => {
  it.each(["apple_priority", "apple_catchup"] as const)(
    "refreshes page zero for %s work even when the queue item is reconciliation-shaped",
    (source) => {
      expect(spotifyArtistWorkScanOptions({ source, workType: "artist_reconciliation" })).toEqual({
        full: false,
        spotifyMode: "daily",
      });
    },
  );

  it("preserves the deep cursor for ordinary reconciliation work", () => {
    expect(
      spotifyArtistWorkScanOptions({ source: "recurring", workType: "artist_reconciliation" }),
    ).toEqual({
      full: true,
      spotifyMode: "reconciliation",
    });
  });
});
