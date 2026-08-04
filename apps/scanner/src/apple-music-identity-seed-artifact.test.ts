import { describe, expect, it } from "vitest";
import {
  appleMusicIdentitySeedExpectedClassifications,
  computeAppleMusicIdentitySeedArtifactHash,
  computeAppleMusicIdentitySeedWatchlistHash,
  createAppleMusicIdentitySeedPlan,
  parseAppleMusicIdentitySeedArtifact,
  type AppleMusicIdentitySeedArtifact,
} from "./apple-music-identity-seed-artifact";
import { parseAppleMusicIdentitySeedPlanCommand } from "./apple-music-identity-seed-plan-cli";

describe("Apple full-watchlist identity-seed artifact", () => {
  it("validates all 593 entries, both hashes, and the exact classification totals", () => {
    const artifact = fixture();
    expect(parseAppleMusicIdentitySeedArtifact(artifact)).toEqual(artifact);
    expect(computeAppleMusicIdentitySeedWatchlistHash(artifact)).toBe(artifact.inputWatchlistHash);
    expect(computeAppleMusicIdentitySeedArtifactHash(artifact)).toBe(artifact.artifactSelfHash);
    expect(artifact.classificationCounts).toEqual(appleMusicIdentitySeedExpectedClassifications);
  });

  it("creates a credential-free aggregate plan with no automatic confirmations", () => {
    expect(createAppleMusicIdentitySeedPlan(fixture())).toMatchObject({
      automaticConfirmations: 0,
      candidateBearingArtistCount: 592,
      candidateIdCount: 877,
      candidatePolicy: "unconfirmed_candidate_until_independent_apple_validation",
      canonicalWatchlistCount: 593,
      credentialsAccessed: false,
      databaseReads: 0,
      databaseWrites: 0,
      futureLiveValidationAuthorized: false,
      futureRequestForecast: "requires_separately_bounded_milestone",
      mode: "apple_identity_seed_plan",
      networkRequestsStarted: 0,
      providerClientInitialized: false,
      tokenGenerated: false,
      unconfirmedArtistCount: 593,
      withoutCandidateCount: 1,
    });
  });

  it("rejects classification, watchlist, and self-hash tampering", () => {
    const counts = fixture();
    counts.classificationCounts.high_confidence_seed -= 1;
    expect(() => parseAppleMusicIdentitySeedArtifact(counts)).toThrow("classification totals");

    const watchlist = fixture();
    watchlist.entries[0]!.canonicalArtistName = "Changed";
    watchlist.artifactSelfHash = computeAppleMusicIdentitySeedArtifactHash(watchlist);
    expect(() => parseAppleMusicIdentitySeedArtifact(watchlist)).toThrow("watchlist hash");

    const selfHash = fixture();
    selfHash.createdAt = "2026-08-03T20:00:00.000Z";
    expect(() => parseAppleMusicIdentitySeedArtifact(selfHash)).toThrow("self-hash");
  });

  it("rejects invalid or contradictory candidate classifications", () => {
    const invalidId = fixture();
    invalidId.entries[0]!.candidateArtistId = "not-numeric";
    expect(() => parseAppleMusicIdentitySeedArtifact(invalidId)).toThrow();

    const confirmedWithoutCandidate = fixture();
    delete confirmedWithoutCandidate.entries[0]!.candidateArtistId;
    confirmedWithoutCandidate.artifactSelfHash =
      computeAppleMusicIdentitySeedArtifactHash(confirmedWithoutCandidate);
    expect(() => parseAppleMusicIdentitySeedArtifact(confirmedWithoutCandidate)).toThrow(
      "lacks a candidate",
    );
  });

  it("parses aggregate, full-watchlist plan, and exactly gated strong-seed commands", () => {
    expect(
      parseAppleMusicIdentitySeedPlanCommand(["--plan", "--artifact", "identity-seeds.json"]),
    ).toEqual({ artifactPath: "identity-seeds.json", mode: "plan" });
    expect(
      parseAppleMusicIdentitySeedPlanCommand([
        "--plan",
        "--full-watchlist-mapping-bootstrap",
        "--artifact",
        "identity-seeds.json",
      ]),
    ).toEqual({ artifactPath: "identity-seeds.json", mode: "full_watchlist_plan" });
    expect(
      parseAppleMusicIdentitySeedPlanCommand([
        "--plan",
        "--stage-b-evidence-replay",
        "--artifact",
        "identity-seeds.json",
      ]),
    ).toEqual({ artifactPath: "identity-seeds.json", mode: "stage_b_evidence_replay" });
    expect(
      parseAppleMusicIdentitySeedPlanCommand([
        "--execute-live",
        "--confirm-live",
        "APPLE_PUBLIC_CATALOG_STRONG_SEEDS_320",
        "--stage",
        "strong_seeds",
        "--artifact",
        "identity-seeds.json",
      ]),
    ).toMatchObject({ mode: "strong_seeds_live", stage: "strong_seeds" });
    expect(() =>
      parseAppleMusicIdentitySeedPlanCommand([
        "--execute-live",
        "--confirm-live",
        "WRONG",
        "--stage",
        "strong_seeds",
        "--artifact",
        "identity-seeds.json",
      ]),
    ).toThrow("APPLE_PUBLIC_CATALOG_STRONG_SEEDS_320");
    expect(() =>
      parseAppleMusicIdentitySeedPlanCommand([
        "--plan",
        "--artifact",
        "identity-seeds.json",
        "--confirm-live",
      ]),
    ).toThrow("Unexpected");
    expect(() =>
      parseAppleMusicIdentitySeedPlanCommand([
        "--plan",
        "--artifact",
        "identity-seeds.json",
        "identity-seeds.json",
      ]),
    ).toThrow("Unexpected");
  });
});

function fixture(): AppleMusicIdentitySeedArtifact {
  const entries: AppleMusicIdentitySeedArtifact["entries"] = [];
  for (let index = 0; index < 593; index += 1) {
    const common = {
      aliasMatchStatus: "none" as const,
      aliases: [],
      canonicalArtistName: `Artist ${index + 1}`,
      conflictingEvidenceCount: 0,
      evidenceSources: ["synthetic_fixture"],
      evidenceTimestamp: "2026-07-30T02:10:30.000Z",
      exactNameMatchStatus: "unique" as const,
      plausibleCandidateCount: 1,
      releaseTitleOverlapCount: 0,
      trackTitleOverlapCount: 0,
      watchedArtistId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    };
    if (index < 307) {
      entries.push({
        ...common,
        alternateCandidateIds: [],
        candidateArtistId: String(index + 1),
        classification: "high_confidence_seed",
        confidence: "high",
      });
    } else if (index < 320) {
      entries.push({
        ...common,
        alternateCandidateIds: [String(10_000 + index)],
        candidateArtistId: String(index + 1),
        classification: "evidence_supported_seed",
        confidence: "evidence_supported",
        exactNameMatchStatus: "multiple",
        plausibleCandidateCount: 2,
      });
    } else if (index < 592) {
      entries.push({
        ...common,
        alternateCandidateIds: [String(20_000 + index * 2), String(20_001 + index * 2)],
        classification: "ambiguous_seed",
        confidence: "ambiguous",
        exactNameMatchStatus: "multiple",
        plausibleCandidateCount: 2,
      });
    } else {
      entries.push({
        ...common,
        alternateCandidateIds: [],
        classification: "manual_review_required",
        confidence: "unresolved",
        exactNameMatchStatus: "none",
        manualReviewReason: "No exact candidate",
        plausibleCandidateCount: 0,
      });
    }
  }
  const artifact: AppleMusicIdentitySeedArtifact = {
    artifactSelfHash: "0".repeat(64),
    canonicalWatchlistCount: 593,
    classificationCounts: { ...appleMusicIdentitySeedExpectedClassifications },
    createdAt: "2026-08-03T19:41:23.525Z",
    entries,
    evidenceCutoffDate: "2026-07-30T02:10:30.000Z",
    inputWatchlistHash: "0".repeat(64),
    itunesRequestCountUsedForExport: 0,
    schemaVersion: 1,
    sourceBranch: "codex/itunes-discovery",
    sourceCommit: "a".repeat(40),
    storefront: "us",
  };
  artifact.inputWatchlistHash = computeAppleMusicIdentitySeedWatchlistHash(artifact);
  artifact.artifactSelfHash = computeAppleMusicIdentitySeedArtifactHash(artifact);
  return artifact;
}
