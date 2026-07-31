import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { artistSearchRequestIdentity } from "./itunes-search-census-planner";
import {
  adaptiveCacheIdentity,
  adaptiveManifestCanonicalContentSha256,
  legacyAlbumLookupIdentity,
  scoreHistoricalIdentityArtist,
  searchResultTruncationRisk,
  serializeAdaptiveManifest,
  simulateAlbumFirst,
  validateAdaptiveManifest,
  type AdaptiveManifest,
} from "./itunes-adaptive-identity-planner";
import type { CensusResultArtifact } from "./itunes-search-census-artifact";
import type {
  HistoricalIdentityArtist,
  HistoricalIdentityRelease,
} from "./itunes-historical-identity-evidence";

describe("adaptive iTunes identity planning", () => {
  it("does not allow one generic single title to become a strong anchor", () => {
    const scored = scoreHistoricalIdentityArtist(
      artist([release({ normalizedTitle: "home", originalTitle: "Home" })]),
    );
    expect(scored.anchorQuality).not.toBe("strong");
    expect(scored.anchors[0]?.exclusionReasons).toContain("generic_release_title");
  });

  it("scores a complete distinctive album above a generic single", () => {
    const generic = scoreHistoricalIdentityArtist(
      artist([release({ normalizedTitle: "home", originalTitle: "Home" })]),
    );
    const album = scoreHistoricalIdentityArtist(
      artist([
        release({
          normalizedTitle: "signals after midnight",
          originalTitle: "Signals After Midnight",
          releaseType: "album",
          tracks: [
            track("Northern Signal", 1),
            track("Midnight Circuit", 2),
            track("Glass Horizon", 3),
          ],
        }),
      ]),
    );
    expect(album.anchorQuality).toBe("strong");
    expect(album.anchorScore).toBeGreaterThan(generic.anchorScore);
  });

  it("does not allow feature-only evidence to confirm identity", () => {
    const feature = release({
      appearanceOrFeatureArtistIds: ["spotify-artist"],
      primaryCreditedArtistIds: ["different-primary"],
    });
    const scored = scoreHistoricalIdentityArtist(artist([feature]));
    expect(scored.featureOnlyEvidence).toBe(true);
    expect(scored.anchors[0]?.quality).toBe("unusable");
    expect(scored.anchors[0]?.exclusionReasons).toContain("feature_only_credit");
  });

  it("preserves version markers and penalizes remix-only evidence", () => {
    const plain = scoreHistoricalIdentityArtist(
      artist([
        release({
          normalizedTitle: "signals after midnight",
          originalTitle: "Signals After Midnight",
        }),
      ]),
    );
    const remix = scoreHistoricalIdentityArtist(
      artist([
        release({
          normalizedTitle: "signals after midnight remix",
          originalTitle: "Signals After Midnight (Remix)",
          versionMarkers: ["remix"],
        }),
      ]),
    );
    expect(remix.anchors[0]?.versionMarkers).toEqual(["remix"]);
    expect(remix.anchorScore).toBeLessThan(plain.anchorScore);
  });

  it("strengthens identity when two independent anchors exist", () => {
    const one = scoreHistoricalIdentityArtist(
      artist([
        release({
          normalizedTitle: "signals after midnight",
          originalTitle: "Signals After Midnight",
        }),
      ]),
    );
    const two = scoreHistoricalIdentityArtist(
      artist([
        release({
          normalizedTitle: "signals after midnight",
          originalTitle: "Signals After Midnight",
          spotifyReleaseId: "release-1",
        }),
        release({
          normalizedTitle: "glass horizon",
          originalTitle: "Glass Horizon",
          spotifyReleaseId: "release-2",
        }),
      ]),
    );
    expect(two.anchorScore).toBeGreaterThan(one.anchorScore);
    expect(two.usableAnchorCount).toBe(2);
  });

  it("keeps truncation as an explicit risk at the configured result limit", () => {
    expect(searchResultTruncationRisk(9)).toBe(false);
    expect(searchResultTruncationRisk(10)).toBe(true);
    expect(searchResultTruncationRisk(25)).toBe(true);
  });

  it("preserves legacy identities and isolates all new cache behavior dimensions", () => {
    const parameters = {
      country: "US",
      entity: "album",
      limit: "25",
      term: "Artist Distinctive Release",
    };
    const base = adaptiveCacheIdentity({
      operationType: "targeted_collection_search",
      parameters,
      providerBehaviorVersion: "targeted-search-v1",
      responseNormalizationVersion: "itunes-normalized-v1",
      storefront: "US",
    });
    expect(
      adaptiveCacheIdentity({
        operationType: "targeted_collection_search",
        parameters,
        providerBehaviorVersion: "targeted-search-v1",
        responseNormalizationVersion: "itunes-normalized-v1",
        storefront: "US",
      }),
    ).toBe(base);
    expect(
      adaptiveCacheIdentity({
        operationType: "targeted_collection_search",
        parameters,
        providerBehaviorVersion: "targeted-search-v2",
        responseNormalizationVersion: "itunes-normalized-v1",
        storefront: "US",
      }),
    ).not.toBe(base);
    expect(
      adaptiveCacheIdentity({
        operationType: "targeted_collection_search",
        parameters,
        providerBehaviorVersion: "targeted-search-v1",
        responseNormalizationVersion: "itunes-normalized-v2",
        storefront: "US",
      }),
    ).not.toBe(base);
    expect(
      adaptiveCacheIdentity({
        operationType: "targeted_collection_search",
        parameters,
        providerBehaviorVersion: "targeted-search-v1",
        responseNormalizationVersion: "itunes-normalized-v1",
        storefront: "GB",
      }),
    ).not.toBe(base);
    expect(base).not.toBe(artistSearchRequestIdentity("Artist"));
    expect(legacyAlbumLookupIdentity("123")).toBe(
      "/lookup?country=US&entity=album&explicit=Yes&id=123&limit=200",
    );
  });

  it("represents an outside-top-10 ID as targeted evidence without confirming it", () => {
    const identity = adaptiveCacheIdentity({
      operationType: "targeted_collection_search",
      parameters: {
        country: "US",
        entity: "album",
        limit: "25",
        term: "Artist Distinctive Release",
      },
      providerBehaviorVersion: "targeted-search-v1",
      responseNormalizationVersion: "itunes-normalized-v1",
      storefront: "US",
    });
    const returnedOutsideTopTen = {
      appleArtistId: "9999999999",
      cacheIdentity: identity,
      corroborated: false,
      originalCandidateIds: Array.from({ length: 10 }, (_, index) => String(index + 1)),
    };
    expect(returnedOutsideTopTen.originalCandidateIds).not.toContain(
      returnedOutsideTopTen.appleArtistId,
    );
    expect(returnedOutsideTopTen.corroborated).toBe(false);
  });

  it("simulates album-first song fallback deterministically", () => {
    const census = {
      analysis: {
        futureCatalogEvidence: {
          newAlbumRequests: 100,
          newSongRequests: 100,
          newTotalRequests: 200,
        },
      },
      artists: [
        {
          canonicalArtistId: "control",
          plausibleCandidateIds: ["1", "2"],
          searchStageMappingState: "competing_exact_or_alias",
        },
        {
          canonicalArtistId: "fallback",
          plausibleCandidateIds: ["3", "4", "5", "6"],
          searchStageMappingState: "competing_exact_or_alias",
        },
      ],
    } as unknown as CensusResultArtifact;
    const pilotSnapshot = {
      artists: [
        { canonicalArtistId: "control", canonicalName: "Control" },
        { canonicalArtistId: "fallback", canonicalName: "Fallback" },
      ],
      snapshotHash: "fixture",
    };
    const evaluation = {
      baseline: {
        corrected: {
          mapping: { ambiguous: 1, evidenceConfirmed: 1, exactConfirmed: 0 },
        },
      },
      identityProvenance: [
        {
          canonicalArtist: "Control",
          canonicalArtistId: "control",
          competingAppleArtistIds: ["2"],
          evidenceItems: [
            {
              evidenceKind: "release" as const,
              spotifyId: "release-a",
              spotifyTitle: "One",
            },
            {
              evidenceKind: "release" as const,
              spotifyId: "release-b",
              spotifyTitle: "Two",
            },
          ],
          selectedAppleArtistId: "1",
        },
      ],
    };
    const first = simulateAlbumFirst(census, pilotSnapshot, evaluation);
    const second = simulateAlbumFirst(census, pilotSnapshot, evaluation);
    expect(first).toEqual(second);
    expect(first.albumOnlyResolvedControls).toBe(1);
    expect(first.songFallbackControls).toBe(1);
    expect(first.estimatedSongRequests).toBe(67);
  });

  it("serializes a bounded dry-run manifest deterministically", () => {
    const content: Omit<AdaptiveManifest, "canonicalContentSha256"> = {
      artists: [
        {
          canonicalArtist: "Fixture Artist",
          canonicalArtistId: "00000000-0000-4000-8000-000000000001",
          stratum: "control",
        },
      ],
      configuration: {
        liveRequestCeilingMs: 900_000,
        maximumArtists: 50,
        maximumNewRequests: 150,
        minimumRequestStartIntervalMs: 3_200,
        oneRequestAtATime: true,
      },
      generatedFrom: {
        censusCanonicalContentSha256: "a".repeat(64),
        historicalEvidenceCanonicalContentSha256: "b".repeat(64),
      },
      kind: "itunes_adaptive_identity_dry_run",
      requests: [
        {
          cacheHit: false,
          cacheIdentity: legacyAlbumLookupIdentity("123"),
          canonicalArtist: "Fixture Artist",
          canonicalArtistId: "00000000-0000-4000-8000-000000000001",
          cohortStratum: "control",
          expectedDecisionContribution: "Fixture contribution.",
          historicalAnchor: "Fixture Release",
          normalizedParameters: {
            country: "US",
            entity: "album",
            explicit: "Yes",
            id: "123",
            limit: "200",
          },
          operationType: "artist_album_lookup",
          reason: "Fixture reason.",
          requestOrder: 1,
          strategy: "album_first",
        },
      ],
      summary: {
        artistCount: 1,
        cacheHits: 0,
        newRequests: 1,
        requestCount: 1,
        runtimeFloorMs: 3_200,
        strategyCounts: { album_first: 1 },
      },
      version: 1,
    };
    const manifest = {
      ...content,
      canonicalContentSha256: adaptiveManifestCanonicalContentSha256(content),
    };
    expect(serializeAdaptiveManifest(manifest)).toBe(serializeAdaptiveManifest(manifest));
    expect(() => validateAdaptiveManifest(manifest)).not.toThrow();
    expect(() =>
      validateAdaptiveManifest({
        ...manifest,
        summary: {
          ...manifest.summary,
          newRequests: 151,
          runtimeFloorMs: 151 * 3_200,
        },
      }),
    ).toThrow(/bounds/);
  });

  it("does not import or initialize a live provider client in the planner", () => {
    const source = readFileSync(
      new URL("./itunes-adaptive-identity-planner.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@radar\/providers|new ItunesClient|fetch\(/);
  });
});

function artist(releases: HistoricalIdentityRelease[]): HistoricalIdentityArtist {
  return {
    aliases: [],
    canonicalArtistId: "00000000-0000-4000-8000-000000000001",
    displayName: "Fixture Artist",
    normalizedName: "fixture artist",
    releases,
    spotifyArtistId: "spotify-artist",
  };
}

function release(overrides: Partial<HistoricalIdentityRelease> = {}): HistoricalIdentityRelease {
  return {
    appearanceOrFeatureArtistIds: [],
    exclusionReasons: [],
    normalizedTitle: "distinctive signal",
    originalTitle: "Distinctive Signal",
    primaryCreditedArtistIds: ["spotify-artist"],
    releaseDate: "2024-01-01",
    releaseDatePrecision: "day",
    releaseType: "single",
    retrievalCompletenessState: "completed",
    sourceObservationTimestamp: "2026-01-01T00:00:00.000Z",
    spotifyReleaseId: "release",
    totalTrackCount: 1,
    tracks: [],
    usableForStrongIdentity: true,
    versionMarkers: [],
    ...overrides,
  };
}

function track(title: string, position: number) {
  return {
    discPosition: 1,
    exclusionReasons: [],
    featureArtistIds: [],
    normalizedTitle: title.toLowerCase(),
    originalTitle: title,
    primaryCreditedArtistIds: ["spotify-artist"],
    sourceObservationTimestamp: "2026-01-01T00:00:00.000Z",
    spotifyTrackId: `track-${position}`,
    trackPosition: position,
    usableForStrongIdentity: true,
    versionMarkers: [],
  };
}
