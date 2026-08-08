import { describe, expect, it } from "vitest";
import { discoverySchedulerRoute, parseDiscoverySchedulerCommand } from "./discovery-scheduler-cli";

describe("discovery scheduler CLI", () => {
  it("parses only the supported commands", () => {
    expect(parseDiscoverySchedulerCommand(["status"])).toBe("status");
    expect(parseDiscoverySchedulerCommand(["--", "tick"])).toBe("tick");
    expect(() => parseDiscoverySchedulerCommand(["run"])).toThrow("Usage:");
  });

  it.each(["ready", "exporting", "partial", "failed"])(
    "routes a %s playlist checkpoint to the automatic exporter",
    (playlistInboxStatus) => {
      expect(discoverySchedulerRoute({ phase: "playlist_inbox", playlistInboxStatus })).toBe(
        "playlist_export",
      );
    },
  );

  it.each(["apple_priority", "apple_catchup_priority", "cooldown_wait"])(
    "routes %s through bounded Spotify priority handling",
    (phase) => {
      expect(discoverySchedulerRoute({ phase, playlistInboxStatus: "pending" })).toBe(
        "spotify_priority",
      );
    },
  );

  it("leaves Apple claims and broad work on the normal route", () => {
    expect(
      discoverySchedulerRoute({ phase: "broad_spotify", playlistInboxStatus: "completed" }),
    ).toBe("apple_or_spotify");
  });
});
