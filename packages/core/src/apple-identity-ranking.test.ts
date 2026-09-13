import { describe, expect, it } from "vitest";
import {
  calibrateAppleIdentityRankings,
  compareAppleIdentityCatalogTitles,
  isGenericAppleCatalogTitle,
  rankAppleIdentityCandidates,
  selectAppleIdentityAutoConfirmation,
  type AppleIdentityCandidateCatalog,
} from "./apple-identity-ranking";

const context = {
  confirmedAppleArtistIds: new Set(["99"]),
  genreFrequency: new Map([["dance", 20]]),
  now: new Date("2026-08-06T00:00:00Z"),
  truthSetSize: 25,
};

describe("Apple identity ranking", () => {
  it("never confirms from catalog, genre, activity, or collaboration signals alone", () => {
    const [ranked] = rankAppleIdentityCandidates(
      [{ catalog: catalog("10", ["10", "99"]), proposedAppleArtistId: "10" }],
      context,
    );
    expect(ranked?.score).toBeLessThan(0.8);
    expect(ranked?.autoConfirmEligible).toBe(false);
    expect(ranked?.signals.confirmedCollaboratorCount).toBe(1);
  });

  it("permits only an exact independent link without contradiction", () => {
    const [confirmed] = rankAppleIdentityCandidates(
      [
        {
          catalog: catalog("10"),
          exactIndependentLink: "musicbrainz_url",
          proposedAppleArtistId: "10",
        },
      ],
      context,
    );
    expect(confirmed).toMatchObject({ autoConfirmEligible: true, score: 1 });
    const [conflicted] = rankAppleIdentityCandidates(
      [
        {
          catalog: catalog("10"),
          claimedByOtherCanonicalArtist: true,
          exactIndependentLink: "wikidata_property",
          proposedAppleArtistId: "10",
        },
      ],
      context,
    );
    expect(conflicted?.autoConfirmEligible).toBe(false);
  });

  it("requires a clear winning margin even when exact links exist", () => {
    const candidates = rankAppleIdentityCandidates(
      [
        { exactIndependentLink: "musicbrainz_url", proposedAppleArtistId: "1" },
        { exactIndependentLink: "wikidata_property", proposedAppleArtistId: "2" },
      ],
      context,
    );
    expect(selectAppleIdentityAutoConfirmation(candidates)).toBeUndefined();
  });

  it("eliminates only directly invalid resources and reports calibration safety", () => {
    const rankings = rankAppleIdentityCandidates(
      [
        { catalog: catalog("10"), proposedAppleArtistId: "10" },
        {
          catalog: { ...catalog("20"), resourceStatus: "invalid" },
          proposedAppleArtistId: "20",
        },
      ],
      context,
    );
    expect(rankings.find((row) => row.appleArtistId === "20")?.eliminationSafe).toBe(true);
    expect(
      calibrateAppleIdentityRankings([{ candidates: rankings, trueAppleArtistId: "10" }]),
    ).toMatchObject({ falseConfirmations: 0, top1Correct: 1, trueCandidatesEliminated: 0 });
  });

  it("preserves remix qualifiers and downweights generic title overlap", () => {
    const left = catalog("10");
    left.releases.push({
      appleReleaseId: "generic",
      artistIds: ["10"],
      artistName: "Artist 10",
      title: "Stay",
    });
    const right = catalog("20");
    right.releases[0]!.title = "Distinct Release (Remix)";
    right.releases.push({
      appleReleaseId: "generic-right",
      artistIds: ["20"],
      artistName: "Artist 20",
      title: "Stay",
    });
    const overlaps = compareAppleIdentityCatalogTitles(left, right);
    expect(overlaps).toEqual([
      expect.objectContaining({ distinctive: false, leftTitle: "Stay", weight: 0.01 }),
    ]);
    expect(isGenericAppleCatalogTitle("track 1")).toBe(true);
  });
});

function catalog(id: string, artistIds: string[] = [id]): AppleIdentityCandidateCatalog {
  return {
    appleArtistId: id,
    artistName: `Artist ${id}`,
    genres: ["Dance"],
    labels: ["Example Records"],
    releases: [
      {
        appleReleaseId: `${id}-album`,
        artistIds,
        artistName: `Artist ${id}`,
        releaseDate: "2026-01-01",
        title: "Distinct Release",
        trackCount: 8,
      },
    ],
    resourceStatus: "valid",
    songs: [],
    source: "itunes_lookup",
  };
}
