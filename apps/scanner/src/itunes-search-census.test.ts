import { readFile } from "node:fs/promises";
import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it } from "vitest";
import {
  censusArtifactContentHashes,
  censusCanaryConditionNames,
  determineCensusCompleteness,
} from "./itunes-search-census-artifact";
import {
  classifySearchStage,
  validateCensusExecutionGate,
  type CensusExecutionGateInput,
} from "./itunes-search-census-executor";

const commit = "a".repeat(40);

function configuration(
  environment: Record<string, string | undefined> = {},
): ReturnType<typeof loadProviderConfiguration> {
  return loadProviderConfiguration({
    DATABASE_URL: "postgres://radar:radar@127.0.0.1:55433/radar_itunes",
    ITUNES_DISCOVERY_ENABLED: "true",
    ITUNES_LANGUAGE: "en_us",
    ITUNES_MAX_REQUESTS_PER_RUN: "150",
    ITUNES_MIN_REQUEST_INTERVAL_MS: "3200",
    ITUNES_STOREFRONT: "US",
    MUSICBRAINZ_ENABLED: "false",
    REDDIT_ENABLED: "false",
    SOUNDCLOUD_MANUAL_LINKS_ENABLED: "false",
    SPOTIFY_ENABLED: "false",
    SPOTIFY_PLAYLIST_WRITES_ENABLED: "false",
    ...environment,
  });
}

function validGate(overrides: Partial<CensusExecutionGateInput> = {}): CensusExecutionGateInput {
  return {
    activeLease: false,
    activeRun: false,
    branch: "codex/itunes-discovery",
    completedShard: false,
    configuration: configuration(),
    expectedBranch: "codex/itunes-discovery",
    expectedCommit: commit,
    explicitLive: true,
    manifestHashMatches: true,
    networkBudget: 125,
    plannedNetworkSearches: 125,
    requestedShardExists: true,
    runtimeMs: 15 * 60_000,
    snapshotHashesMatch: true,
    sourceCommit: commit,
    worktreeClean: true,
    ...overrides,
  };
}

describe("iTunes full-watchlist search census execution gate", () => {
  it("accepts only the exact isolated, enabled, clean checkpoint", () => {
    expect(() => validateCensusExecutionGate(validGate())).not.toThrow();
  });

  it.each([
    ["missing explicit live mode", { explicitLive: false }],
    [
      "disabled iTunes runtime",
      { configuration: configuration({ ITUNES_DISCOVERY_ENABLED: "false" }) },
    ],
    [
      "wrong database",
      {
        configuration: configuration({
          DATABASE_URL: "postgres://radar:radar@127.0.0.1:55434/radar_itunes_test",
        }),
      },
    ],
    ["snapshot hash mismatch", { snapshotHashesMatch: false }],
    ["manifest hash mismatch", { manifestHashMatches: false }],
    ["invalid shard", { requestedShardExists: false }],
    ["completed shard", { completedShard: true }],
    ["active run", { activeRun: true }],
    ["active lease", { activeLease: true }],
    ["wrong branch", { branch: "codex/other" }],
    ["wrong commit", { sourceCommit: "b".repeat(40) }],
    ["dirty worktree", { worktreeClean: false }],
    ["budget over 150", { networkBudget: 151, plannedNetworkSearches: 151 }],
    ["budget differs from plan", { networkBudget: 124 }],
    ["runtime over 15 minutes", { runtimeMs: 15 * 60_000 + 1 }],
    [
      "pacing below 3200 ms",
      {
        configuration: {
          ...configuration(),
          itunes: { ...configuration().itunes, minRequestIntervalMs: 3199 },
        },
      },
    ],
    ["Spotify enabled", { configuration: configuration({ SPOTIFY_ENABLED: "true" }) }],
    ["MusicBrainz enabled", { configuration: configuration({ MUSICBRAINZ_ENABLED: "true" }) }],
  ] satisfies Array<[string, Partial<CensusExecutionGateInput>]>)(
    "rejects %s",
    (_name, overrides) => {
      expect(() => validateCensusExecutionGate(validGate(overrides))).toThrow();
    },
  );
});

describe("iTunes search-stage classification", () => {
  const artist = {
    active: true as const,
    aliases: ["Alternate Name"],
    canonicalArtistId: "11111111-1111-4111-8111-111111111111",
    displayName: "Canonical Name",
    normalizedName: "canonical name",
    spotifyArtistId: "spotify-id",
  };
  const candidate = (artistId: string, artistName: string) => ({
    artistId,
    artistLinkUrl: undefined,
    artistName,
    artistViewUrl: undefined,
    wrapperType: "artist" as const,
  });
  const response = (artists: ReturnType<typeof candidate>[]) => ({
    artists,
    collections: [],
    declaredResultCount: artists.length,
    tracks: [],
    unknownResultCount: 0,
  });

  it("distinguishes unique canonical, alias, competing, and absent matches", () => {
    expect(classifySearchStage(artist, response([candidate("1", "Canonical Name")])).state).toBe(
      "unique_exact_canonical",
    );
    expect(classifySearchStage(artist, response([candidate("2", "Alternate Name")])).state).toBe(
      "unique_alias_supported",
    );
    expect(
      classifySearchStage(
        artist,
        response([candidate("1", "Canonical Name"), candidate("2", "Canonical Name")]),
      ).state,
    ).toBe("competing_exact_or_alias");
    expect(classifySearchStage(artist, response([candidate("3", "Different Name")])).state).toBe(
      "no_exact_or_alias_candidate",
    );
  });

  it("rejects a normalized response containing non-artist results", () => {
    expect(
      classifySearchStage(artist, {
        ...response([]),
        collections: [
          {
            collectionId: "1",
            collectionName: "Unexpected",
            collectionViewUrl: undefined,
            releaseDate: "2026-07-29T00:00:00Z",
            wrapperType: "collection",
          },
        ],
      }).state,
    ).toBe("rejected_unsafe_result");
  });
});

describe("dedicated census command architecture", () => {
  it("exposes only artist search on its narrowed client boundary", async () => {
    const source = await readFile(
      new URL("./itunes-search-census-executor.ts", import.meta.url),
      "utf8",
    );
    const boundary = source.match(/interface ArtistSearchOnlyClient \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;
    expect(boundary).toContain("searchArtists");
    expect(boundary).not.toMatch(/lookup|album|song|batch|collection/i);
  });

  it("keeps the legacy pilot runner untouched by the census module", async () => {
    const source = await readFile(
      new URL("./itunes-search-census-executor.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("itunes-pilot-runner");
    expect(source).not.toContain("runLiveItunesPilot");
  });
});

describe("census verifier and artifact invariants", () => {
  it("enumerates every mandatory canary failure boundary", () => {
    expect(censusCanaryConditionNames).toEqual([
      "terminal_artist_count",
      "expected_cache_hits",
      "expected_network_searches",
      "shard_membership",
      "duplicate_artists",
      "duplicate_search_identities",
      "unexpected_retries",
      "http_errors",
      "http_429",
      "retry_after",
      "parsing_errors",
      "response_bound_errors",
      "redirect_errors",
      "minimum_pacing",
      "overlap_count",
      "search_only_path",
      "no_lookup",
      "no_batch",
      "no_other_provider",
      "run_terminal",
      "no_active_run",
      "no_active_lease",
      "snapshot_hash",
      "manifest_hash",
      "source_unchanged",
      "original_worktree_unchanged",
      "safe_persisted_shape",
    ]);
  });

  it("hashes identical artifact content deterministically", () => {
    const content = {
      artists: [{ canonicalArtistId: "1", state: "completed" }],
      completenessState: "controlled_partial",
      shards: [{ shard: 1, status: "completed" }],
    };
    expect(censusArtifactContentHashes(content)).toEqual(censusArtifactContentHashes(content));
    expect(censusArtifactContentHashes(content)).not.toEqual(
      censusArtifactContentHashes({ ...content, completenessState: "complete" }),
    );
  });

  it("distinguishes complete, controlled-partial, and failed artifacts", () => {
    expect(determineCensusCompleteness(["completed"], 150, 593)).toBe("controlled_partial");
    expect(
      determineCensusCompleteness(["completed", "completed", "completed", "completed"], 593, 593),
    ).toBe("complete");
    expect(
      determineCensusCompleteness(["completed", "failed", "completed", "completed"], 300, 593),
    ).toBe("failed");
  });
});
