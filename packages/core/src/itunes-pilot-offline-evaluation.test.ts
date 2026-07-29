import { describe, expect, it } from "vitest";
import {
  assertItunesOfflineEvidenceIntegrity,
  buildItunesArtistConfusionMatrix,
  freezeItunesMappingForWindow,
  ratio,
  simulateItunesFallbackPolicy,
  type ItunesArtistCandidateOutcome,
} from "./itunes-pilot-offline-evaluation";
import type { ItunesIdentityCandidateCatalog, SpotifyGroundTruthRelease } from "./itunes-pilot";

function release(id: string, date: string): SpotifyGroundTruthRelease {
  return {
    canonicalReleaseId: `canonical-${id}`,
    normalizedTitle: "known release",
    releaseDate: date,
    releaseType: "single",
    spotifyReleaseId: id,
    title: "Known Release",
    trackCount: 1,
    tracks: [{ normalizedTitle: "known track", title: "Known Track" }],
  };
}

function catalog(artistId: string): ItunesIdentityCandidateCatalog {
  return {
    candidate: { artistId, artistName: "Artist" },
    collections: [
      {
        artistId,
        collectionId: `collection-${artistId}`,
        collectionName: "Known Release",
        releaseDate: "2026-06-01T00:00:00.000Z",
        source: "both",
        trackCount: 1,
      },
    ],
    tracks: [
      {
        artistId,
        artistName: "Artist",
        collectionId: `collection-${artistId}`,
        collectionName: "Known Release",
        releaseDate: "2026-06-01T00:00:00.000Z",
        trackId: `track-${artistId}`,
        trackName: "Known Track",
      },
    ],
  };
}

describe("iTunes temporal identity holdout", () => {
  it("does not allow target-window evidence to establish the mapping being scored", () => {
    const result = freezeItunesMappingForWindow({
      aliases: [],
      candidateCatalogs: [catalog("selected"), catalog("competitor")],
      canonicalName: "Artist",
      correctedSelectedArtistId: "selected",
      correctedStatus: "evidence_confirmed",
      groundTruth: [release("target", "2026-06-01")],
      targetWindowStart: "2026-05-30",
    });
    expect(result.provenance).toBe("target_window_assisted");
    expect(result).not.toHaveProperty("selectedArtistId");
  });

  it("allows pre-window historical evidence to establish the corrected mapping", () => {
    const competitor = catalog("competitor");
    competitor.collections = [];
    competitor.tracks = [];
    expect(
      freezeItunesMappingForWindow({
        aliases: [],
        candidateCatalogs: [catalog("selected"), competitor],
        canonicalName: "Artist",
        correctedSelectedArtistId: "selected",
        correctedStatus: "evidence_confirmed",
        groundTruth: [release("historical", "2026-06-01")],
        targetWindowStart: "2026-06-15",
      }),
    ).toMatchObject({
      historicalEvidenceReleaseIds: ["historical"],
      provenance: "historical_evidence",
      selectedArtistId: "selected",
    });
  });

  it("keeps an exact independent mapping usable without Spotify release evidence", () => {
    expect(
      freezeItunesMappingForWindow({
        aliases: [],
        candidateCatalogs: [],
        canonicalName: "Artist",
        correctedSelectedArtistId: "selected",
        correctedStatus: "exact_confirmed",
        groundTruth: [],
        targetWindowStart: "2026-06-15",
      }),
    ).toMatchObject({
      provenance: "independent_exact",
      selectedArtistId: "selected",
    });
  });
});

describe("iTunes artist-level product evaluation", () => {
  const outcomes: ItunesArtistCandidateOutcome[] = [
    {
      appleCandidate: true,
      artistId: "tp",
      artistName: "True Positive",
      safelyMapped: true,
      spotifyPositive: true,
      spotifyReleaseIds: ["release-1", "release-2"],
    },
    {
      appleCandidate: true,
      artistId: "fp",
      artistName: "False Positive",
      safelyMapped: true,
      spotifyPositive: false,
      spotifyReleaseIds: [],
    },
    {
      appleCandidate: false,
      artistId: "tn",
      artistName: "True Negative",
      safelyMapped: true,
      spotifyPositive: false,
      spotifyReleaseIds: [],
    },
    {
      appleCandidate: false,
      artistId: "fn",
      artistName: "False Negative",
      safelyMapped: true,
      spotifyPositive: true,
      spotifyReleaseIds: ["release-3"],
    },
    {
      appleCandidate: false,
      artistId: "unresolved",
      artistName: "Unresolved",
      safelyMapped: false,
      spotifyPositive: true,
      spotifyReleaseIds: ["release-4"],
    },
  ];

  it("builds confusion matrices from artists rather than release rows", () => {
    const matrix = buildItunesArtistConfusionMatrix([
      ...outcomes,
      { ...outcomes[0]!, spotifyReleaseIds: ["release-2"] },
    ]);
    expect(matrix).toMatchObject({
      falseNegatives: 1,
      falsePositives: 1,
      precision: 0.5,
      recall: 0.5,
      specificity: 0.5,
      trueNegatives: 1,
      truePositives: 1,
    });
  });

  it("falls back for unresolved artists and deduplicates Apple confirmations", () => {
    const simulation = simulateItunesFallbackPolicy([
      ...outcomes,
      { ...outcomes[0]!, spotifyReleaseIds: ["release-2"] },
    ]);
    expect(simulation.totalSpotifyQueries).toBe(3);
    expect(simulation.queriedArtists).toEqual(["False Positive", "True Positive", "Unresolved"]);
    expect(simulation.unresolvedArtistsSent).toEqual(["Unresolved"]);
    expect(simulation.appleCandidateArtistsSent).toEqual(["False Positive", "True Positive"]);
    expect(simulation.incorrectlySkippedArtists).toEqual(["False Negative"]);
    expect(simulation.spotifyQueriesAvoided).toBe(2);
  });

  it("uses deterministic raw-count denominators", () => {
    expect(ratio(2, 5)).toBe(0.4);
    expect(ratio(0, 0)).toBe(0);
  });

  it("rejects changed first-run or corrected-run evidence totals", () => {
    const evidence = {
      cacheRows: 258,
      correctedCacheHits: 102,
      correctedMappings: 50,
      correctedNetworkRequests: 150,
      correctedRequestEvents: 252,
      firstCacheHits: 0,
      firstMappings: 50,
      firstNetworkRequests: 108,
      firstRequestEvents: 108,
    };
    expect(() => assertItunesOfflineEvidenceIntegrity(evidence)).not.toThrow();
    expect(() =>
      assertItunesOfflineEvidenceIntegrity({ ...evidence, correctedRequestEvents: 253 }),
    ).toThrow("Persisted iTunes pilot evidence changed");
  });
});
