import { describe, expect, it } from "vitest";
import type { AppleMusicIdentitySeedArtifact } from "./apple-music-identity-seed-artifact";
import {
  buildAppleMusicStageBGroundTruth,
  calculateAppleMusicStageBCadence,
  createAppleMusicStageBManualDecisionArtifact,
  createAppleMusicStageBPhase2Plan,
  createAppleMusicStageBReviewArtifact,
  createAppleMusicStageBReviewHtml,
  extractAppleMusicStageBCandidateCatalogs,
  parseAppleMusicStageBManualDecisionArtifact,
  replayAppleMusicStageB,
  validateAppleMusicStageBReviewArtifact,
  type AppleMusicStageBCandidateCatalog,
  type AppleMusicStageBSourceRelease,
} from "./apple-music-stage-b";

const ambiguousOne = "00000000-0000-4000-8000-000000000001";
const ambiguousTwo = "00000000-0000-4000-8000-000000000002";
const candidateFree = "00000000-0000-4000-8000-000000000003";

describe("Apple Music Stage B offline evidence", () => {
  it("normalizes cached ISRC and UPC evidence without retaining raw responses", () => {
    const catalogs = extractAppleMusicStageBCandidateCatalogs(
      {
        albums: [],
        artists: [],
        cacheResponses: [
          {
            data: [
              {
                attributes: { genreNames: ["Electronic"], name: "Artist" },
                id: "101",
                type: "artists",
              },
              {
                attributes: {
                  artistName: "Artist",
                  name: "Signal",
                  releaseDate: "2026-07-01",
                  upc: "012345678905",
                },
                id: "201",
                relationships: { artists: { data: [{ id: "101", type: "artists" }] } },
                type: "albums",
              },
              {
                attributes: {
                  albumName: "Signal",
                  artistName: "Artist",
                  isrc: "us-aaa-26-00001",
                  name: "Signal",
                  releaseDate: "2026-07-01",
                },
                id: "301",
                relationships: {
                  albums: { data: [{ id: "201", type: "albums" }] },
                  artists: { data: [{ id: "101", type: "artists" }] },
                },
                type: "songs",
              },
            ],
          },
        ],
        songs: [],
      },
      new Set(["101"]),
    );
    expect(catalogs.get("101")).toMatchObject({
      albums: [expect.objectContaining({ upc: "012345678905" })],
      artist: { genreNames: ["Electronic"], name: "Artist" },
      songs: [expect.objectContaining({ isrc: "USAAA2600001" })],
    });
    expect(JSON.stringify(catalogs)).not.toContain("authorization");
  });

  it("builds deterministic ground truth with provenance and honest missing-code coverage", () => {
    const value = artifact();
    const supplemental: AppleMusicStageBSourceRelease = {
      ...sourceRelease(),
      evidenceSource: "tracked_sanitized_itunes_evidence",
      sourceReleaseId: "source-2",
      tracks: [{ title: "Second Track" }],
    };
    const first = buildAppleMusicStageBGroundTruth(value, [sourceRelease(), supplemental]);
    const second = buildAppleMusicStageBGroundTruth(value, [supplemental, sourceRelease()]);
    expect(first).toEqual(second);
    expect(first.get(ambiguousOne)).toMatchObject({
      evidenceSources: ["approved_frozen_spotify_snapshot", "tracked_sanitized_itunes_evidence"],
      releases: [
        expect.objectContaining({
          evidenceCutoff: "2026-07-29T23:59:59.000Z",
          evidenceSource: "approved_frozen_spotify_snapshot",
        }),
      ],
    });
    expect(first.get(ambiguousOne)?.releases[0]?.tracks?.map((track) => track.title)).toEqual([
      "Second Track",
      "Signal",
    ]);
    expect(first.get(ambiguousOne)?.releases[0]).not.toHaveProperty("upc");
    expect(first.get(ambiguousOne)?.releases[0]?.tracks?.[0]).not.toHaveProperty("isrc");
  });

  it("replays every ambiguous and candidate-free entry without side effects", () => {
    const value = artifact();
    const groundTruth = buildAppleMusicStageBGroundTruth(value, [sourceRelease()]);
    const catalogs = candidateCatalogs();
    const replay = replayAppleMusicStageB({
      artifact: value,
      candidateCatalogs: catalogs,
      groundTruth,
      now: new Date("2026-07-29T23:59:59Z"),
    });
    expect(replay.counts).toEqual({
      candidate_free_manual_review: 1,
      conflicting_identity_evidence: 0,
      insufficient_watched_artist_ground_truth: 1,
      manual_review_likely: 0,
      offline_auto_resolvable: 1,
      requires_live_candidate_evidence: 0,
    });
    expect(replay.artists).toHaveLength(3);
    expect(replay.safety).toEqual({
      credentialsAccessed: false,
      databaseWrites: 0,
      developerTokenGenerated: false,
      networkRequestsStarted: 0,
      privateKeyAccessed: false,
      providerClientInitialized: false,
    });
  });

  it("reports missing cadence instead of inventing it and ranks deterministically", () => {
    expect(calculateAppleMusicStageBCadence([], new Date("2026-07-29T23:59:59Z"))).toEqual({
      coverage: "unavailable",
      releases181To365Days: 0,
      releases91To180Days: 0,
      releasesOlderThan365Days: 0,
      releasesWithin90Days: 0,
      score: 0,
      tier: "unknown",
    });
    expect(
      calculateAppleMusicStageBCadence(
        buildAppleMusicStageBGroundTruth(artifact(), [sourceRelease()]).get(ambiguousOne)!.releases,
        new Date("2026-07-29T23:59:59Z"),
      ),
    ).toMatchObject({ coverage: "dated_history", score: 8, tier: "medium" });
  });

  it("creates an ignored-style assisted review and strict hash-bound decisions", () => {
    const value = artifact();
    const catalogs = candidateCatalogs();
    const replay = replayAppleMusicStageB({
      artifact: value,
      candidateCatalogs: catalogs,
      groundTruth: buildAppleMusicStageBGroundTruth(value, [sourceRelease()]),
      now: new Date("2026-07-29T23:59:59Z"),
    });
    const review = createAppleMusicStageBReviewArtifact({
      artifact: value,
      candidateCatalogs: catalogs,
      createdAt: new Date("2026-07-29T23:59:59Z"),
      replay,
    });
    expect(review.artists[0]).toMatchObject({
      cadence: { score: 8 },
      canonicalName: "Artist One",
    });
    expect(review.artists[0]?.candidates[0]).toMatchObject({ candidateArtistId: "101", rank: 1 });
    expect(validateAppleMusicStageBReviewArtifact(review, value.artifactSelfHash)).toEqual(review);
    expect(() =>
      validateAppleMusicStageBReviewArtifact(
        { ...review, evidenceCutoff: "2026-07-30T00:00:00.000Z" },
        value.artifactSelfHash,
      ),
    ).toThrow("hash validation failed");
    const filtered = createAppleMusicStageBReviewArtifact({
      artifact: value,
      candidateCatalogs: catalogs,
      createdAt: new Date("2026-07-29T23:59:59Z"),
      replay,
      resolvedWatchedArtistIds: new Set([ambiguousOne]),
    });
    expect(filtered.artists.some((artist) => artist.watchedArtistId === ambiguousOne)).toBe(false);
    const html = createAppleMusicStageBReviewHtml(review);
    expect(html).toContain("Download decision artifact");
    expect(html).not.toMatch(/authorization|developer.?token|private.?key/i);

    const decision = createAppleMusicStageBManualDecisionArtifact({
      decisions: [
        {
          decision: "confirm",
          decidedAt: "2026-07-29T23:59:59.000Z",
          selectedCandidateId: "101",
          watchedArtistId: ambiguousOne,
        },
      ],
      reviewArtifactHash: review.artifactSelfHash,
    });
    expect(parseAppleMusicStageBManualDecisionArtifact(decision, review)).toEqual(decision);
    expect(() =>
      parseAppleMusicStageBManualDecisionArtifact(
        {
          ...decision,
          decisions: [{ ...decision.decisions[0]!, selectedCandidateId: "102" }],
        },
        review,
      ),
    ).toThrow(/hash validation|outside the bound review/);
  });

  it("builds exact nonauthorized batches of no more than 50 artists", () => {
    const value = artifact();
    const catalogs = candidateCatalogs();
    const replay = replayAppleMusicStageB({
      artifact: value,
      candidateCatalogs: catalogs,
      groundTruth: buildAppleMusicStageBGroundTruth(value, [sourceRelease()]),
      now: new Date("2026-07-29T23:59:59Z"),
    });
    const plan = createAppleMusicStageBPhase2Plan({
      artifact: value,
      candidateCatalogs: catalogs,
      replay,
    });
    expect(plan).toMatchObject({
      ambiguousArtists: 2,
      executionAuthorized: false,
      maximumArtistsPerBatch: 50,
      pacingIsProviderAllowance: false,
    });
    expect(plan.batches.every((batch) => batch.artistCount <= 50)).toBe(true);
  });
});

function sourceRelease(): AppleMusicStageBSourceRelease {
  return {
    canonicalReleaseId: "release-1",
    evidenceCutoff: "2026-07-29T23:59:59.000Z",
    evidenceSource: "approved_frozen_spotify_snapshot",
    releaseDate: "2026-07-01",
    releaseType: "single",
    sourceReleaseId: "source-1",
    title: "Signal",
    tracks: [{ title: "Signal" }],
    watchedArtistId: ambiguousOne,
  };
}

function candidateCatalogs(): Map<string, AppleMusicStageBCandidateCatalog> {
  return new Map([
    [
      "101",
      {
        albums: [
          {
            albumId: "201",
            artistIds: ["101"],
            artistName: "Artist One",
            paginationPath: "offline",
            pageNumber: 1,
            releaseDate: "2026-07-01",
            sourceView: "album",
            title: "Signal",
          },
        ],
        artist: { artistId: "101", name: "Artist One" },
        evidenceSources: ["existing_sanitized_apple_database_and_cache"],
        songs: [],
      },
    ],
    [
      "102",
      {
        albums: [
          {
            albumId: "202",
            artistIds: ["102"],
            artistName: "Artist One",
            paginationPath: "offline",
            pageNumber: 1,
            releaseDate: "2026-07-01",
            sourceView: "album",
            title: "Unrelated",
          },
        ],
        artist: { artistId: "102", name: "Artist One" },
        evidenceSources: ["existing_sanitized_apple_database_and_cache"],
        songs: [],
      },
    ],
  ]);
}

function artifact(): AppleMusicIdentitySeedArtifact {
  return {
    artifactSelfHash: "a".repeat(64),
    canonicalWatchlistCount: 3,
    classificationCounts: {
      ambiguous_seed: 2,
      evidence_supported_seed: 0,
      high_confidence_seed: 0,
      manual_review_required: 1,
      no_candidate: 0,
    },
    createdAt: "2026-07-29T23:59:59.000Z",
    entries: [
      {
        aliasMatchStatus: "none",
        aliases: [],
        alternateCandidateIds: ["101", "102"],
        canonicalArtistName: "Artist One",
        classification: "ambiguous_seed",
        confidence: "ambiguous",
        conflictingEvidenceCount: 0,
        evidenceSources: ["synthetic"],
        evidenceTimestamp: "2026-07-29T23:59:59.000Z",
        exactNameMatchStatus: "multiple",
        plausibleCandidateCount: 2,
        releaseTitleOverlapCount: 0,
        trackTitleOverlapCount: 0,
        watchedArtistId: ambiguousOne,
      },
      {
        aliasMatchStatus: "none",
        aliases: [],
        alternateCandidateIds: ["201", "202", "203"],
        canonicalArtistName: "Artist Two",
        classification: "ambiguous_seed",
        confidence: "ambiguous",
        conflictingEvidenceCount: 0,
        evidenceSources: ["synthetic"],
        evidenceTimestamp: "2026-07-29T23:59:59.000Z",
        exactNameMatchStatus: "multiple",
        plausibleCandidateCount: 3,
        releaseTitleOverlapCount: 0,
        trackTitleOverlapCount: 0,
        watchedArtistId: ambiguousTwo,
      },
      {
        aliasMatchStatus: "none",
        aliases: [],
        alternateCandidateIds: [],
        canonicalArtistName: "Candidate Free",
        classification: "manual_review_required",
        confidence: "unresolved",
        conflictingEvidenceCount: 0,
        evidenceSources: ["synthetic"],
        evidenceTimestamp: "2026-07-29T23:59:59.000Z",
        exactNameMatchStatus: "none",
        plausibleCandidateCount: 0,
        releaseTitleOverlapCount: 0,
        trackTitleOverlapCount: 0,
        watchedArtistId: candidateFree,
      },
    ],
    evidenceCutoffDate: "2026-07-29T23:59:59.000Z",
    inputWatchlistHash: "b".repeat(64),
    itunesRequestCountUsedForExport: 0,
    schemaVersion: 1,
    sourceBranch: "codex/itunes-discovery",
    sourceCommit: "c".repeat(40),
    storefront: "us",
  };
}
