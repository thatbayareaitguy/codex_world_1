import { describe, expect, it } from "vitest";

import { formatFeedArtistCredits } from "./feed-format";

describe("formatFeedArtistCredits", () => {
  it("separates multiple primary artists with commas", () => {
    expect(
      formatFeedArtistCredits([
        { creditedName: "IMANU", role: "primary" },
        { creditedName: "Stabbed by Angels", role: "primary" },
      ]),
    ).toBe("IMANU, Stabbed by Angels");
  });

  it("retains one featured-artist marker and comma-separated names", () => {
    expect(
      formatFeedArtistCredits([
        { creditedName: "Vybz Kartel", role: "primary" },
        { creditedName: "SHY FX", role: "featured" },
        { creditedName: "CLIPZ", role: "featured" },
      ]),
    ).toBe("Vybz Kartel, feat. SHY FX, CLIPZ");
  });

  it("returns an empty string when no credits are supplied", () => {
    expect(formatFeedArtistCredits([])).toBe("");
  });
});
