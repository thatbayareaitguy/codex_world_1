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
    });
  });

  it("validates since dates", () => {
    expect(parseArgs(["--since", "2026-07-01"])).toMatchObject({ since: "2026-07-01" });
    expect(() => parseArgs(["--since", "not-a-date"])).toThrow("valid ISO date");
  });
});
