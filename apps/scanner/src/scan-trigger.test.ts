import { describe, expect, it } from "vitest";
import { providerScanTriggerType } from "./scan-trigger";

describe("scan-history trigger attribution", () => {
  it("distinguishes internal fixed Apple workflows from manual provider scans", () => {
    expect(
      providerScanTriggerType(
        "apple_music",
        {
          dryRun: false,
          full: false,
          provider: "apple_music",
        },
        "apple_full_scheduled",
      ),
    ).toBe("apple_full_scheduled");
    expect(
      providerScanTriggerType(
        "apple_music",
        {
          dryRun: false,
          full: false,
          provider: "apple_music",
        },
        "apple_catchup_scheduled",
      ),
    ).toBe("apple_catchup_scheduled");
    expect(
      providerScanTriggerType("apple_music", {
        dryRun: false,
        full: false,
        provider: "apple_music",
        source: "apple_full_scheduler",
      }),
    ).toBe("provider_manual");
  });

  it("does not trust a public source label for scheduled attribution", () => {
    expect(
      providerScanTriggerType("spotify", {
        artistId: "artist",
        dryRun: false,
        full: false,
        provider: "spotify",
        source: "spotify_scheduler",
      }),
    ).toBe("provider_manual");
    expect(
      providerScanTriggerType(
        "spotify",
        {
          artistId: "artist",
          dryRun: false,
          full: false,
          provider: "spotify",
        },
        "spotify_scheduled",
      ),
    ).toBe("spotify_scheduled");
  });
});
