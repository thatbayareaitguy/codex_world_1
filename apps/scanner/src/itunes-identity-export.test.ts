import { readFile } from "node:fs/promises";
import { ItunesClient, type ItunesRequestPersistence } from "@radar/providers";
import { describe, expect, it } from "vitest";
import {
  assertIdentityExportCanExecute,
  buildIdentitySeedArtifact,
  createIdentityExportPlan,
  identityExportAlternateCandidateLimit,
  identityExportExpectedBranch,
  parseIdentitySeedArtifact,
  type IdentityExportDatabaseEvidence,
} from "./itunes-identity-export";

const commit = "a".repeat(40);
const createdAt = "2026-08-03T12:00:00.000Z";

describe("iTunes full-watchlist identity export", () => {
  it("plans deterministically with zero network requests and zero database writes", () => {
    const first = plan([artist()]);
    const second = plan([artist()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      canonicalWatchlistCount: 1,
      databaseWrites: 0,
      expectedRuntimeMs: 0,
      networkRequestForecast: 0,
    });
  });

  it("rejects duplicate internal watched artists", () => {
    const duplicate = artist();
    expect(() => plan([duplicate, duplicate], [inventory()])).toThrow(/duplicate internal/i);
  });

  it("represents duplicate canonical names without conflating internal identities", () => {
    const first = artist();
    const second = artist({
      canonicalArtistId: "22222222-2222-4222-8222-222222222222",
      plausibleCandidateIds: ["43"],
      candidates: [{ artistId: "43", artistName: "Canonical Artist" }],
    });
    const result = plan([first, second], [inventory(), inventory(second.canonicalArtistId)]);
    expect(result.duplicateCanonicalNameCount).toBe(1);
    expect(result.duplicateInternalArtistCount).toBe(0);
  });

  it("reuses a corrected evidence-supported mapping and preserves overlap counts", () => {
    const evidence = databaseEvidence({
      candidates: [
        {
          artistId: "42",
          artistLinkUrl: "https://music.apple.com/us/artist/canonical-artist/42",
          artistName: "Canonical Artist",
        },
      ],
      canonicalArtistId: artist().canonicalArtistId,
      evidence: [
        {
          artistId: "42",
          conflictingReleases: ["conflict"],
          exactReleaseTitleMatches: 2,
          trackTitleOverlap: 3,
        },
      ],
      selectedArtistId: "42",
    });
    const artifact = build(
      [
        artist({
          exactCanonicalCandidateCount: 2,
          plausibleCandidateIds: ["42", "43"],
          candidates: [
            { artistId: "42", artistName: "Canonical Artist" },
            { artistId: "43", artistName: "Canonical Artist" },
          ],
          searchStageMappingState: "competing_exact_or_alias",
        }),
      ],
      [inventory()],
      evidence,
    );
    expect(artifact.entries[0]).toMatchObject({
      candidateArtistId: "42",
      classification: "evidence_supported_seed",
      conflictingEvidenceCount: 1,
      releaseTitleOverlapCount: 2,
      trackTitleOverlapCount: 3,
    });
  });

  it("exports a unique exact-name result as a candidate without claiming confirmation", () => {
    const entry = build().entries[0]!;
    expect(entry).toMatchObject({
      candidateArtistId: "42",
      classification: "high_confidence_seed",
      exactNameMatchStatus: "unique",
    });
    expect(entry.evidenceSources).not.toContain("apple_confirmed");
  });

  it("does not use search rank alone to create a high-confidence seed", () => {
    const entry = build([
      artist({
        exactCanonicalCandidateCount: 0,
        plausibleCandidateIds: [],
        searchStageMappingState: "no_exact_or_alias_candidate",
      }),
    ]).entries[0]!;
    expect(entry.classification).toBe("manual_review_required");
    expect(entry.candidateArtistId).toBeUndefined();
  });

  it("accepts an alias candidate only when the alias is approved", () => {
    const approved = artist({
      aliases: ["Approved Alias"],
      candidates: [{ artistId: "42", artistName: "Approved Alias" }],
      exactAliasCandidateCount: 1,
      exactCanonicalCandidateCount: 0,
      searchStageMappingState: "unique_alias_supported",
    });
    expect(build([approved]).entries[0]?.classification).toBe("high_confidence_seed");
    expect(() => build([{ ...approved, aliases: [] }])).toThrow(/approved alias/i);
  });

  it("keeps multiple exact candidates ambiguous", () => {
    const entry = build([
      artist({
        candidates: [
          { artistId: "42", artistName: "Canonical Artist" },
          { artistId: "43", artistName: "Canonical Artist" },
        ],
        declaredResultCount: 2,
        exactCanonicalCandidateCount: 2,
        plausibleCandidateIds: ["42", "43"],
        searchStageMappingState: "competing_exact_or_alias",
      }),
    ]).entries[0]!;
    expect(entry).toMatchObject({
      alternateCandidateIds: ["42", "43"],
      classification: "ambiguous_seed",
      plausibleCandidateCount: 2,
    });
  });

  it("retains a true no-result artist as no_candidate", () => {
    const entry = build([
      artist({
        candidates: [],
        declaredResultCount: 0,
        exactCanonicalCandidateCount: 0,
        plausibleCandidateIds: [],
        searchStageMappingState: "no_exact_or_alias_candidate",
      }),
    ]).entries[0]!;
    expect(entry.classification).toBe("no_candidate");
  });

  it("treats public numeric candidate IDs as operational values and excludes private data", () => {
    const serialized = JSON.stringify(build());
    expect(build().entries[0]?.candidateArtistId).toMatch(/^\d+$/);
    expect(serialized).not.toMatch(/credential|token|rawPayload|artwork|preview|spotify/i);
  });

  it("detects artifact modification through its self-hash", () => {
    const artifact = build();
    const modified = {
      ...artifact,
      entries: [{ ...artifact.entries[0]!, canonicalArtistName: "Changed" }],
    };
    expect(() => parseIdentitySeedArtifact(modified)).toThrow(/self-hash/i);
  });

  it("keeps classification totals equal to the exported watchlist", () => {
    const artifact = build();
    expect(
      Object.values(artifact.classificationCounts).reduce((sum, count) => sum + count, 0),
    ).toBe(artifact.canonicalWatchlistCount);
  });

  it("is deterministic apart from caller-supplied metadata", () => {
    expect(build()).toEqual(build());
    expect(build().artifactSelfHash).toBe(build().artifactSelfHash);
  });

  it("rejects alternate-candidate lists above the bound", () => {
    const ids = Array.from({ length: identityExportAlternateCandidateLimit + 1 }, (_, index) =>
      String(index + 1),
    );
    expect(() =>
      build([
        artist({
          candidates: ids.map((artistId) => ({ artistId, artistName: "Canonical Artist" })),
          declaredResultCount: ids.length,
          exactCanonicalCandidateCount: ids.length,
          plausibleCandidateIds: ids,
          searchStageMappingState: "competing_exact_or_alias",
        }),
      ]),
    ).toThrow(/bounded alternate-candidate/i);
  });

  it("can be repeated without duplicating requests or artists", () => {
    const first = build();
    const resumed = build();
    expect(resumed.itunesRequestCountUsedForExport).toBe(0);
    expect(resumed.entries).toEqual(first.entries);
    expect(new Set(resumed.entries.map((entry) => entry.watchedArtistId)).size).toBe(
      resumed.entries.length,
    );
  });

  it("retains only allowlisted HTTPS public artist-page URLs", () => {
    const entry = build().entries[0]!;
    expect(entry.publicArtistPageUrl).toBe("https://music.apple.com/us/artist/canonical-artist/42");
    const unsafe = databaseEvidence();
    unsafe.publicArtistUrls = new Map([["42", "https://lookalike.invalid/artist/42"]]);
    expect(
      build([artist()], [inventory()], unsafe).entries[0]?.publicArtistPageUrl,
    ).toBeUndefined();
  });

  it("records HTTP 429 once and stops without retrying the injected provider request", async () => {
    const completions: Array<Parameters<ItunesRequestPersistence["complete"]>[0]> = [];
    let requests = 0;
    const persistence: ItunesRequestPersistence = {
      acquire: () =>
        Promise.resolve({
          eventId: "event",
          leaseToken: "lease",
          startedAt: new Date(createdAt),
        }),
      complete: (input) => {
        completions.push(input);
        return Promise.resolve();
      },
      loadCache: () => Promise.resolve(null),
      recordCacheHit: () => Promise.resolve(),
    };
    const client = new ItunesClient({
      enabled: true,
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(
          new Response("{}", { headers: { "retry-after": "60" }, status: 429 }),
        );
      },
      persistence,
    });
    await expect(client.searchArtists("run", "Artist")).rejects.toMatchObject({
      classification: "rate_limited",
      retryAfterSeconds: 60,
      status: 429,
    });
    expect(requests).toBe(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      errorClassification: "rate_limited",
      retryAfterSeconds: 60,
      status: 429,
    });
  });

  it("stops before HTTP work when cached census evidence is incomplete", () => {
    const incomplete = artist({ terminalProcessingState: "not_processed" });
    const before = databaseEvidence();
    const result = plan([incomplete], [inventory()], before);
    expect(result.networkRequestForecast).toBe(1);
    expect(() => assertIdentityExportCanExecute(result)).toThrow(/refuses uncached work/i);
    expect(before).toEqual(databaseEvidence());
  });

  it("contains no provider client or network call and requires providers disabled", async () => {
    const implementation = await readFile(
      new URL("./itunes-identity-export.ts", import.meta.url),
      "utf8",
    );
    const cli = await readFile(new URL("./itunes-identity-export-cli.ts", import.meta.url), "utf8");
    expect(implementation).not.toContain("fetch(");
    expect(implementation).not.toContain("ItunesClient");
    expect(cli).toContain("assertEveryProviderDisabled");
    expect(cli).not.toContain("fetch(");
  });

  it("parses the exported artifact independently without database access", () => {
    const artifact = build();
    expect(parseIdentitySeedArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });
});

type Census = Parameters<typeof createIdentityExportPlan>[0]["census"];
type CensusArtist = Census["artists"][number];
type Inventory = Parameters<typeof createIdentityExportPlan>[0]["inventory"];

function artist(overrides: Partial<CensusArtist> = {}): CensusArtist {
  return {
    aliases: [],
    candidates: [{ artistId: "42", artistName: "Canonical Artist" }],
    canonicalArtistId: "11111111-1111-4111-8111-111111111111",
    declaredResultCount: 1,
    displayName: "Canonical Artist",
    exactAliasCandidateCount: 0,
    exactCanonicalCandidateCount: 1,
    normalizedName: "canonical artist",
    plausibleCandidateIds: ["42"],
    searchStageMappingState: "unique_exact_canonical",
    terminalProcessingState: "completed",
    ...overrides,
  };
}

function inventory(
  canonicalArtistId = artist().canonicalArtistId,
  canonicalName = artist().displayName,
): Inventory[number] {
  return {
    anchorQuality: "unusable",
    canonicalArtistId,
    canonicalName,
    noUsableHistoricalEvidence: true,
    usableIdentityAnchorCount: 0,
  };
}

function census(artists: CensusArtist[]): Census {
  return {
    artists,
    canonicalContentSha256: "b".repeat(64),
    completenessState: "complete",
    kind: "itunes_full_watchlist_search_census",
  };
}

function databaseEvidence(
  mapping?: IdentityExportDatabaseEvidence["evidenceMappings"][number],
): IdentityExportDatabaseEvidence {
  return {
    activeLease: false,
    activeRun: false,
    evidenceMappings: mapping ? [mapping] : [],
    historicalNetworkRequestCount: 880,
    providerCooldownActive: false,
    publicArtistUrls: new Map([["42", "https://music.apple.com/us/artist/canonical-artist/42"]]),
  };
}

function plan(
  artists: CensusArtist[],
  inventoryRows: Inventory = artists.map((item) =>
    inventory(item.canonicalArtistId, item.displayName),
  ),
  evidence = databaseEvidence(),
) {
  return createIdentityExportPlan({
    artifactPath: "artifacts/apple-music-identity-seeds-v1.json",
    branch: identityExportExpectedBranch,
    census: census(artists),
    databaseEvidence: evidence,
    inventory: inventoryRows,
    reportPath: "docs/apple-music-identity-seed-export.md",
    sourceCommit: commit,
  });
}

function build(
  artists: CensusArtist[] = [artist()],
  inventoryRows: Inventory = artists.map((item) =>
    inventory(item.canonicalArtistId, item.displayName),
  ),
  evidence = databaseEvidence(),
) {
  return buildIdentitySeedArtifact({
    branch: identityExportExpectedBranch,
    census: census(artists),
    createdAt,
    databaseEvidence: evidence,
    inventory: inventoryRows,
    sourceCommit: commit,
  });
}
