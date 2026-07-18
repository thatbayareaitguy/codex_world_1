import {
  matchCandidate,
  type CanonicalTrack,
  type MatchDecision,
  type TrackCandidate,
} from "@radar/core";
import type { ProviderReleaseObservation } from "@radar/providers";

export interface DryRunCandidateReport {
  artistName: string;
  backfillEligible: boolean;
  externalReleaseId: string;
  externalTrackId: string;
  match: MatchDecision;
  persistenceAction: "would_create" | "would_skip_existing";
  persistenceReasons: string[];
  releaseDate: string;
  releaseTitle: string;
  releaseType: string;
  title: string;
  version?: string;
}

export interface DryRunReport {
  ambiguousCandidates: DryRunCandidateReport[];
  backfillStart: string;
  candidatesWouldCreate: DryRunCandidateReport[];
  discovery: {
    pagesScanned: number;
    partial: boolean;
    requestCount: number;
    status: "succeeded";
  };
  finalOperationalStep:
    | { status: "pending" | "completed" }
    | { classification: string; message: string; status: "failed" };
  persistence: { canonicalWrites: 0; status: "skipped" };
  rejectedCandidates: DryRunCandidateReport[];
  releases: ProviderReleaseObservation[];
  trackCandidates: DryRunCandidateReport[];
}

interface BuildDryRunReportInput {
  backfillStart: string;
  candidates: TrackCandidate[];
  canonicalTracks: CanonicalTrack[];
  existingCandidateKeys: ReadonlySet<string>;
  pagesScanned: number;
  partial: boolean;
  providerTrackMatches: ReadonlyMap<string, string>;
  releases: ProviderReleaseObservation[];
  requestCount: number;
}

export function buildDryRunReport(input: BuildDryRunReportInput): DryRunReport {
  const trackCandidates = input.candidates.map((candidate) => {
    const existing = input.existingCandidateKeys.has(candidateKey(candidate));
    const providerTrackId = input.providerTrackMatches.get(candidate.externalTrackId);
    const match: MatchDecision = providerTrackId
      ? {
          canonicalTrackId: providerTrackId,
          confidence: 1,
          kind: "automatic",
          reasons: ["Provider track identifier is identical"],
          rule: "exact_provider_id",
        }
      : matchCandidate(candidate, input.canonicalTracks);
    return {
      artistName: candidate.artistName,
      backfillEligible: candidate.releaseDate >= input.backfillStart,
      externalReleaseId: candidate.externalReleaseId,
      externalTrackId: candidate.externalTrackId,
      match,
      persistenceAction: existing ? "would_skip_existing" : "would_create",
      persistenceReasons: [
        ...(existing ? ["Provider release and track candidate already exists"] : []),
        ...(candidate.releaseDate < input.backfillStart
          ? [`Release date is before backfill start ${input.backfillStart}`]
          : []),
        ...(!existing && candidate.releaseDate >= input.backfillStart
          ? ["Candidate is inside the backfill and is not already persisted"]
          : []),
      ],
      releaseDate: candidate.releaseDate,
      releaseTitle: candidate.releaseTitle,
      releaseType: candidate.releaseType,
      title: candidate.title,
      ...(candidate.version ? { version: candidate.version } : {}),
    } satisfies DryRunCandidateReport;
  });
  return {
    ambiguousCandidates: trackCandidates.filter((candidate) => candidate.match.kind === "review"),
    backfillStart: input.backfillStart,
    candidatesWouldCreate: trackCandidates.filter(
      (candidate) => candidate.persistenceAction === "would_create",
    ),
    discovery: {
      pagesScanned: input.pagesScanned,
      partial: input.partial,
      requestCount: input.requestCount,
      status: "succeeded",
    },
    finalOperationalStep: { status: "pending" },
    persistence: { canonicalWrites: 0, status: "skipped" },
    rejectedCandidates: trackCandidates.filter(
      (candidate) =>
        !candidate.backfillEligible || candidate.persistenceAction === "would_skip_existing",
    ),
    releases: input.releases,
    trackCandidates,
  };
}

export function candidateKey(
  candidate: Pick<TrackCandidate, "externalReleaseId" | "externalTrackId" | "provider">,
): string {
  return `${candidate.provider}:${candidate.externalReleaseId}:${candidate.externalTrackId}`;
}
