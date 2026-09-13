import type { CanonicalTrack, TrackCandidate } from "@radar/core";
import type { ProviderReleaseObservation } from "@radar/providers";
import { describe, expect, it } from "vitest";
import { buildDryRunReport, candidateKey } from "./dry-run-report";
import { DryRunOperationalError, runDryRunFinalOperationalStep, type ScanSummary } from "./scan";

const candidates: TrackCandidate[] = [
  candidate("new-track", "New Track", "July Release", "2026-07-16"),
  candidate("existing-track", "Existing Track", "Earlier Release", "2026-07-10"),
];

const releases: ProviderReleaseObservation[] = [
  {
    backfillEligible: true,
    candidateCount: 1,
    externalReleaseId: "release-july",
    reasons: ["Release date is on or after backfill start 2026-05-19"],
    releaseDate: "2026-07-16",
    releaseDatePrecision: "day",
    releaseType: "single",
    selectedForDetails: true,
    title: "July Release",
    totalTracks: 1,
  },
  {
    backfillEligible: false,
    candidateCount: 0,
    externalReleaseId: "release-old",
    reasons: ["Release date is before backfill start 2026-05-19"],
    releaseDate: "2025-01-01",
    releaseDatePrecision: "day",
    releaseType: "album",
    selectedForDetails: false,
    title: "Old Release",
    totalTracks: 10,
  },
];

const canonicalTracks: CanonicalTrack[] = [
  {
    credits: [{ name: "Different Artist", role: "primary" }],
    id: "canonical-existing",
    normalizedTitle: "existing track",
    title: "Existing Track",
  },
];

describe("Spotify dry-run reporting", () => {
  it("reports releases, dates, candidates, ambiguity, and skipped persistence", () => {
    const report = buildDryRunReport({
      backfillStart: "2026-05-19",
      candidates,
      canonicalTracks,
      existingCandidateKeys: new Set([candidateKey(candidates[1]!)]),
      pagesScanned: 1,
      partial: true,
      providerTrackMatches: new Map(),
      releases,
      requestCount: 3,
    });

    expect(report.releases.map((release) => [release.title, release.releaseDate])).toEqual([
      ["July Release", "2026-07-16"],
      ["Old Release", "2025-01-01"],
    ]);
    expect(report.candidatesWouldCreate.map((candidate) => candidate.title)).toEqual(["New Track"]);
    expect(report.ambiguousCandidates).toHaveLength(1);
    expect(report.ambiguousCandidates[0]?.match.reasons).toContain("Score is below 0.93");
    expect(report.rejectedCandidates).toHaveLength(1);
    expect(report.rejectedCandidates[0]?.persistenceReasons).toContain(
      "Provider release and track candidate already exists",
    );
    expect(report.persistence).toEqual({ canonicalWrites: 0, status: "skipped" });
    expect(report.discovery).toMatchObject({ pagesScanned: 1, partial: true, requestCount: 3 });
  });

  it("keeps the structured result when a final operational step fails", async () => {
    const summary: ScanSummary = {
      discovered: 2,
      dryRun: true,
      dryRunReport: buildDryRunReport({
        backfillStart: "2026-05-19",
        candidates,
        canonicalTracks,
        existingCandidateKeys: new Set(),
        pagesScanned: 1,
        partial: false,
        providerTrackMatches: new Map(),
        releases,
        requestCount: 3,
      }),
      inserted: 0,
      needsReview: 0,
      skipped: 0,
    };

    const error = await runDryRunFinalOperationalStep(summary, "request_deferral_failed", () =>
      Promise.reject(new Error("synthetic final telemetry failure")),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DryRunOperationalError);
    expect((error as DryRunOperationalError).summary.dryRunReport).toMatchObject({
      discovery: { status: "succeeded" },
      finalOperationalStep: {
        classification: "request_deferral_failed",
        message: "synthetic final telemetry failure",
        status: "failed",
      },
      persistence: { canonicalWrites: 0, status: "skipped" },
    });
  });
});

function candidate(
  externalTrackId: string,
  title: string,
  releaseTitle: string,
  releaseDate: string,
): TrackCandidate {
  return {
    artistExternalId: "spotify-yussi",
    artistName: "YUSSI",
    availability: "playable",
    credits: [{ name: "YUSSI", role: "primary" }],
    durationMs: 180_000,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/${externalTrackId}`,
    externalReleaseId: releaseTitle === "July Release" ? "release-july" : "release-earlier",
    externalTrackId,
    firstSeenAt: "2026-07-18T09:00:00.000Z",
    payloadHash: `hash-${externalTrackId}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/${externalTrackId}`,
    region: "US",
    releaseDate,
    releaseDatePrecision: "day",
    releaseTitle,
    releaseType: "single",
    sourceLabel: "Spotify catalog",
    title,
  };
}
