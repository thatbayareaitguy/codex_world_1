import { describe, expect, it } from "vitest";
import { parseAppleFirstSyncOptions } from "./apple-first-sync-cli";

describe("Apple-first synchronization CLI", () => {
  it("defaults to a guarded run", () => {
    expect(parseAppleFirstSyncOptions([])).toEqual({
      confirmLiveProviders: false,
      mode: "run",
    });
  });

  it("parses bounded canary and cohort options", () => {
    expect(
      parseAppleFirstSyncOptions([
        "run",
        "--confirm-live-providers",
        "--artist-limit",
        "5",
        "--max-cohorts",
        "2",
        "--spotify-cohort-size",
        "5",
        "--spotify-page-limit",
        "1",
        "--spotify-rotation-size",
        "2",
      ]),
    ).toEqual({
      artistLimit: 5,
      confirmLiveProviders: true,
      maxCohorts: 2,
      mode: "run",
      spotifyCohortSize: 5,
      spotifyPageLimit: 1,
      spotifyRotationSize: 2,
    });
  });

  it("rejects malformed bounds", () => {
    expect(() => parseAppleFirstSyncOptions(["--spotify-page-limit", "0"])).toThrow(
      "--spotify-page-limit requires an integer from 1 to 50.",
    );
  });
});
