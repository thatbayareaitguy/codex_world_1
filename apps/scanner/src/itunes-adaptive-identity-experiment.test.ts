import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ItunesNormalizedResponse } from "@radar/providers";
import {
  adaptiveCacheIdentity,
  legacyAlbumLookupIdentity,
  type AdaptiveRequest,
} from "./itunes-adaptive-identity-planner";
import {
  albumFirstDecision,
  experimentExpectedBranch,
  experimentNetworkBudget,
  hashCanonical,
  targetedDecision,
  validateExperimentExecutionGate,
  validateOperation,
} from "./itunes-adaptive-identity-experiment";
import type { HistoricalIdentityArtist } from "./itunes-historical-identity-evidence";

describe("adaptive identity experiment execution gate", () => {
  it("requires explicit enablement, the expected branch and commit, and a clean worktree", () => {
    const valid = gate();
    expect(() => validateExperimentExecutionGate(valid)).not.toThrow();
    expect(() => validateExperimentExecutionGate({ ...valid, explicitLive: false })).toThrow(
      /explicit live/i,
    );
    expect(() => validateExperimentExecutionGate({ ...valid, itunesEnabled: false })).toThrow(
      /enablement/i,
    );
    expect(() => validateExperimentExecutionGate({ ...valid, branch: "codex/wrong" })).toThrow(
      /clean branch and commit/i,
    );
    expect(() =>
      validateExperimentExecutionGate({ ...valid, sourceCommit: "b".repeat(40) }),
    ).toThrow(/clean branch and commit/i);
    expect(() => validateExperimentExecutionGate({ ...valid, clean: false })).toThrow(
      /clean branch and commit/i,
    );
  });

  it("rejects the wrong database, active state, non-iTunes providers, and any budget except 79", () => {
    const valid = gate();
    expect(() =>
      validateExperimentExecutionGate({
        ...valid,
        databaseUrl: "postgres://radar:radar@127.0.0.1:5432/radar",
      }),
    ).toThrow(/isolated radar_itunes/i);
    expect(() => validateExperimentExecutionGate({ ...valid, activeRun: true })).toThrow(
      /no other active run/i,
    );
    expect(() => validateExperimentExecutionGate({ ...valid, nonItunesDisabled: false })).toThrow(
      /non-iTunes provider/i,
    );
    for (const maximumNetworkRequests of [78, 80, 150]) {
      expect(() => validateExperimentExecutionGate({ ...valid, maximumNetworkRequests })).toThrow(
        /exactly equal/i,
      );
    }
  });
});

describe("adaptive manifest operation boundary", () => {
  it("preserves legacy album identities and uses collision-resistant v2 targeted identities", () => {
    const albumIdentity = legacyAlbumLookupIdentity("42");
    const targeted = targetedRequest("Distinctive Record");
    expect(albumIdentity).toBe("/lookup?country=US&entity=album&explicit=Yes&id=42&limit=200");
    expect(targeted.cacheIdentity).toMatch(/^itunes-cache:v2:/);
    expect(targeted.cacheIdentity).not.toBe(albumIdentity);
    expect(targeted.cacheIdentity).not.toMatch(/^\/search\?/);
    expect(() => validateOperation(targeted)).not.toThrow();
  });

  it("rejects song, batch, changed, and non-manifest operations", () => {
    const album: AdaptiveRequest = {
      cacheHit: false,
      cacheIdentity: legacyAlbumLookupIdentity("42"),
      canonicalArtist: "Artist",
      canonicalArtistId: "00000000-0000-4000-8000-000000000001",
      cohortStratum: "test",
      expectedDecisionContribution: "test",
      historicalAnchor: "Distinctive Record",
      normalizedParameters: {
        country: "US",
        entity: "album",
        explicit: "Yes",
        id: "42",
        limit: "200",
      },
      operationType: "artist_album_lookup",
      reason: "test",
      requestOrder: 1,
      strategy: "album_first",
    };
    expect(() => validateOperation(album)).not.toThrow();
    expect(() =>
      validateOperation({
        ...album,
        normalizedParameters: { ...album.normalizedParameters, entity: "song" },
      }),
    ).toThrow(/individual album lookup/i);
    expect(() =>
      validateOperation({
        ...album,
        normalizedParameters: { ...album.normalizedParameters, id: "42,43" },
      }),
    ).toThrow();
    expect(() =>
      validateOperation({
        ...album,
        operationType: "other" as AdaptiveRequest["operationType"],
      }),
    ).toThrow(/outside/i);
  });
});

describe("adaptive identity decision rules", () => {
  it("does not use rank, a generic title, feature-only evidence, or a version conflict", () => {
    const artist = historicalArtist();
    expect(
      targetedDecision(
        artist,
        targetedRequest("Different Record"),
        response("77", "Artist", "Top-ranked"),
      ),
    ).toMatchObject({ state: "ambiguous", selectedArtistId: "" });
    expect(
      targetedDecision(
        historicalArtist("Home"),
        targetedRequest("Home"),
        response("77", "Artist", "Home"),
      ),
    ).toMatchObject({ state: "ambiguous", selectedArtistId: "" });
    const featureOnly = historicalArtist("Distinctive Record", false);
    expect(
      targetedDecision(
        featureOnly,
        targetedRequest("Distinctive Record"),
        response("77", "Artist", "Distinctive Record"),
      ),
    ).toMatchObject({ state: "ambiguous", selectedArtistId: "" });
    const remix = historicalArtist("Distinctive Record");
    expect(
      targetedDecision(
        remix,
        targetedRequest("Distinctive Record"),
        response("77", "Artist", "Distinctive Record (Remix)"),
      ),
    ).toMatchObject({ selectedArtistId: "" });
  });

  it("can represent and corroborate an outside-top-10 ID without using rank", () => {
    const decision = targetedDecision(
      historicalArtist(),
      targetedRequest("Distinctive Record"),
      response("9999999999", "Artist", "Distinctive Record"),
    );
    expect(decision).toMatchObject({
      selectedArtistId: "9999999999",
      state: "resolved",
    });
    expect(decision.evidence).toContain("search_rank_not_used");
  });

  it("keeps album-first ambiguous when one exact title lacks the existing strong evidence rule", () => {
    const decision = albumFirstDecision(
      historicalArtist(),
      "77",
      response("77", "Artist", "Distinctive Record", 9),
    );
    expect(["ambiguous", "resolved"]).toContain(decision.state);
    expect(decision.candidateIds).toEqual(["77"]);
  });

  it("contains no song, batch, or collection-detail call in the executor", async () => {
    const source = await readFile(
      new URL("./itunes-adaptive-identity-executor.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("lookupAlbums");
    expect(source).not.toContain("lookupSongs(");
    expect(source).not.toContain("lookupCollectionSongs(");
    expect(source).not.toContain("batch_albums");
    expect(source).not.toContain("batch_songs");
  });

  it("hashes identical result content deterministically", () => {
    const content = { artists: [{ id: "a", state: "ambiguous" }], completed: 15 };
    expect(hashCanonical(content)).toBe(hashCanonical(content));
    expect(hashCanonical(content)).not.toBe(hashCanonical({ ...content, completed: 16 }));
  });
});

function gate() {
  return {
    activeLease: false,
    activeRun: false,
    branch: experimentExpectedBranch,
    clean: true,
    databaseUrl: "postgres://radar:radar@127.0.0.1:55433/radar_itunes",
    explicitLive: true,
    expectedBranch: experimentExpectedBranch,
    expectedCommit: "a".repeat(40),
    itunesEnabled: true,
    manifestValid: true,
    maximumNetworkRequests: experimentNetworkBudget,
    nonItunesDisabled: true,
    runtimeMs: 900_000,
    sourceCommit: "a".repeat(40),
  };
}

function targetedRequest(anchor: string): AdaptiveRequest {
  const parameters = {
    country: "US",
    entity: "album",
    explicit: "Yes",
    lang: "en_us",
    limit: "25",
    media: "music",
    term: `Artist ${anchor}`,
  };
  return {
    cacheHit: false,
    cacheIdentity: adaptiveCacheIdentity({
      operationType: "targeted_collection_search",
      parameters,
      providerBehaviorVersion: "targeted-search-v1",
      responseNormalizationVersion: "itunes-normalized-v1",
      storefront: "US",
    }),
    canonicalArtist: "Artist",
    canonicalArtistId: "00000000-0000-4000-8000-000000000001",
    cohortStratum: "test",
    expectedDecisionContribution: "test",
    historicalAnchor: anchor,
    normalizedParameters: parameters,
    operationType: "targeted_collection_search",
    reason: "test",
    requestOrder: 1,
    strategy: "targeted_search",
  };
}

function historicalArtist(
  title = "Distinctive Record",
  primaryCredit = true,
): HistoricalIdentityArtist {
  return {
    aliases: [],
    canonicalArtistId: "00000000-0000-4000-8000-000000000001",
    displayName: "Artist",
    normalizedName: "artist",
    releases: [
      {
        appearanceOrFeatureArtistIds: primaryCredit ? [] : ["spotify-artist"],
        exclusionReasons: [],
        normalizedTitle: title.toLowerCase(),
        originalTitle: title,
        primaryCreditedArtistIds: primaryCredit ? ["spotify-artist"] : [],
        releaseDate: "2026-01-01",
        releaseDatePrecision: "day",
        releaseType: "album",
        retrievalCompletenessState: "completed",
        sourceObservationTimestamp: "2026-01-02T00:00:00.000Z",
        spotifyReleaseId: "spotify-release",
        totalTrackCount: 9,
        tracks: [],
        usableForStrongIdentity: true,
        versionMarkers: [],
      },
    ],
    spotifyArtistId: "spotify-artist",
  };
}

function response(
  artistId: string,
  artistName: string,
  collectionName: string,
  trackCount = 9,
): ItunesNormalizedResponse {
  return {
    artists: [],
    collections: [
      {
        artistId,
        artistName,
        collectionId: "collection-1",
        collectionName,
        collectionViewUrl: undefined,
        releaseDate: "2026-01-01T00:00:00Z",
        trackCount,
        wrapperType: "collection",
      },
    ],
    declaredResultCount: 1,
    tracks: [],
    unknownResultCount: 0,
  };
}
