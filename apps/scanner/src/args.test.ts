import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("supports dry-run and debugging filters", () => {
    expect(
      parseArgs(["--", "--dry-run", "--provider", "mock", "--artist", "artist-1", "--full"]),
    ).toEqual({
      dryRun: true,
      full: true,
      provider: "mock",
      artistId: "artist-1",
      spotifyConfirmBatch: false,
      spotifyMode: "reconciliation",
    });
  });

  it("parses bounded Spotify batch controls", () => {
    expect(
      parseArgs([
        "--provider",
        "spotify",
        "--spotify-mode",
        "initial",
        "--spotify-batch",
        "batch-1",
        "--confirm-spotify-batch",
        "--spotify-max-pages",
        "1",
      ]),
    ).toMatchObject({
      provider: "spotify",
      spotifyBatchId: "batch-1",
      spotifyConfirmBatch: true,
      spotifyMaxPages: 1,
      spotifyMode: "initial",
    });
  });

  it("validates since dates", () => {
    expect(parseArgs(["--since", "2026-07-01"])).toMatchObject({ since: "2026-07-01" });
    expect(() => parseArgs(["--since", "not-a-date"])).toThrow("valid ISO date");
  });
});
