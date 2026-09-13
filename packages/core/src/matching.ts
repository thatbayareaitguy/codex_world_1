import { extractVersion, normalizeIdentifier, normalizeText, normalizedCredits } from "./normalize";
import type {
  CanonicalTrack,
  MatchDecision,
  MatchRule,
  ProviderName,
  TrackCandidate,
} from "./types";

const AUTOMATIC_THRESHOLD = 0.93;
const DURATION_TOLERANCE_MS = 2_000;

export type ExactStableTrackIdentityRule = Extract<
  MatchRule,
  "exact_provider_id" | "exact_isrc" | "exact_barcode_position" | "exact_musicbrainz"
>;

export interface StableTrackIdentityCandidate {
  discNumber?: number | null | undefined;
  ean?: string | null | undefined;
  externalTrackId?: string | null | undefined;
  isrc?: string | null | undefined;
  musicbrainzRecordingId?: string | null | undefined;
  musicbrainzReleaseGroupId?: string | null | undefined;
  provider?: ProviderName | null | undefined;
  title: string;
  trackNumber?: number | null | undefined;
  upc?: string | null | undefined;
}

export interface StableTrackIdentityTarget extends StableTrackIdentityCandidate {
  normalizedTitle?: string | null | undefined;
  providerExternalIds?:
    | ReadonlyArray<{
        externalId: string;
        provider: ProviderName;
      }>
    | undefined;
}

export interface ExactStableTrackIdentityMatch<T extends StableTrackIdentityTarget> {
  rule: ExactStableTrackIdentityRule;
  target: T;
}

export function matchCandidate(
  candidate: TrackCandidate,
  tracks: readonly CanonicalTrack[],
): MatchDecision {
  const exact = findExactStableTrackIdentity(candidate, tracks);
  if (exact) {
    const exactEvidence = {
      exact_barcode_position: {
        confidence: 0.99,
        reason: "Barcode, disc, and track position are identical",
      },
      exact_isrc: {
        confidence: 1,
        reason: `ISRC ${normalizeIdentifier(candidate.isrc ?? "")} is identical`,
      },
      exact_musicbrainz: {
        confidence: 0.98,
        reason:
          "MusicBrainz recording ID is identical, or release group, position, and title agree",
      },
      exact_provider_id: {
        confidence: 1,
        reason: "Provider track identifier is identical",
      },
    } satisfies Record<ExactStableTrackIdentityRule, { confidence: number; reason: string }>;
    const evidence = exactEvidence[exact.rule];
    return automatic(exact.target.id, exact.rule, evidence.confidence, [evidence.reason]);
  }

  const metadataCandidates = tracks
    .map((track) => scoreMetadata(candidate, track))
    .filter((result) => result.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
  const best = metadataCandidates[0];

  if (!best) {
    return {
      kind: "new",
      rule: "new_canonical",
      confidence: 1,
      reasons: ["No existing canonical recording has comparable metadata"],
    };
  }

  const tied = metadataCandidates[1]?.confidence === best.confidence;
  if (best.confidence >= AUTOMATIC_THRESHOLD && !tied && !best.versionConflict) {
    return automatic(best.track.id, "metadata", best.confidence, best.reasons);
  }

  return {
    kind: "review",
    rule: "manual_review",
    confidence: best.confidence,
    canonicalTrackId: best.track.id,
    reasons: [
      ...best.reasons,
      tied ? "Multiple canonical tracks have the same score" : "Score is below 0.93",
      ...(best.versionConflict ? ["Version markers conflict"] : []),
    ],
  };
}

export function exactStableTrackIdentityRule(
  incoming: StableTrackIdentityCandidate,
  proposed: StableTrackIdentityTarget,
): ExactStableTrackIdentityRule | undefined {
  return findExactStableTrackIdentity(incoming, [proposed])?.rule;
}

export function findExactStableTrackIdentity<T extends StableTrackIdentityTarget>(
  incoming: StableTrackIdentityCandidate,
  proposedTracks: readonly T[],
): ExactStableTrackIdentityMatch<T> | undefined {
  if (incoming.provider && incoming.externalTrackId) {
    const providerExact = proposedTracks.find((track) =>
      track.providerExternalIds?.some(
        (externalId) =>
          externalId.provider === incoming.provider &&
          externalId.externalId === incoming.externalTrackId,
      ),
    );
    if (providerExact) return { rule: "exact_provider_id", target: providerExact };
  }

  if (incoming.isrc) {
    const normalized = normalizeIdentifier(incoming.isrc);
    const isrcExact = proposedTracks.find(
      (track) => track.isrc && normalizeIdentifier(track.isrc) === normalized,
    );
    if (isrcExact) return { rule: "exact_isrc", target: isrcExact };
  }

  const incomingBarcode = incoming.upc ?? incoming.ean;
  if (incomingBarcode && incoming.trackNumber !== undefined && incoming.trackNumber !== null) {
    const normalized = normalizeIdentifier(incomingBarcode);
    const barcodeExact = proposedTracks.find((track) => {
      const proposedBarcode = track.upc ?? track.ean;
      return (
        proposedBarcode !== undefined &&
        proposedBarcode !== null &&
        normalizeIdentifier(proposedBarcode) === normalized &&
        track.trackNumber === incoming.trackNumber &&
        (track.discNumber ?? 1) === (incoming.discNumber ?? 1)
      );
    });
    if (barcodeExact) {
      return { rule: "exact_barcode_position", target: barcodeExact };
    }
  }

  if (incoming.musicbrainzRecordingId) {
    const recordingExact = proposedTracks.find(
      (track) => track.musicbrainzRecordingId === incoming.musicbrainzRecordingId,
    );
    if (recordingExact) return { rule: "exact_musicbrainz", target: recordingExact };
  }

  if (incoming.musicbrainzReleaseGroupId && incoming.trackNumber !== undefined) {
    const releaseGroupExact = proposedTracks.find(
      (track) =>
        track.musicbrainzReleaseGroupId === incoming.musicbrainzReleaseGroupId &&
        track.trackNumber === incoming.trackNumber &&
        (track.discNumber ?? 1) === (incoming.discNumber ?? 1) &&
        (track.normalizedTitle ?? normalizeText(track.title)) === normalizeText(incoming.title),
    );
    if (releaseGroupExact) return { rule: "exact_musicbrainz", target: releaseGroupExact };
  }

  return undefined;
}

function scoreMetadata(candidate: TrackCandidate, track: CanonicalTrack) {
  let confidence = 0;
  const reasons: string[] = [];
  const candidateTitle = normalizeText(candidate.title);
  const titleEqual = candidateTitle === track.normalizedTitle;
  if (!titleEqual) return { track, confidence, reasons, versionConflict: false };

  if (!primaryArtistCreditsOverlap(candidate.credits, track.credits)) {
    return { track, confidence, reasons, versionConflict: false };
  }

  confidence += 0.45;
  reasons.push("Normalized titles are identical");

  if (normalizedCredits(candidate.credits) === normalizedCredits(track.credits)) {
    confidence += 0.3;
    reasons.push("Canonical artist credits are identical");
  }

  const candidateVersion = candidate.version ?? extractVersion(candidate.title);
  const trackVersion = track.version ?? extractVersion(track.title);
  const versionConflict =
    candidateVersion !== undefined &&
    trackVersion !== undefined &&
    candidateVersion !== trackVersion;
  if (!versionConflict && candidateVersion === trackVersion) {
    confidence += 0.15;
    reasons.push("Version markers agree");
  }

  if (
    candidate.durationMs !== undefined &&
    track.durationMs !== undefined &&
    Math.abs(candidate.durationMs - track.durationMs) <= DURATION_TOLERANCE_MS
  ) {
    confidence += 0.1;
    reasons.push("Durations are within two seconds");
  }

  return { track, confidence: round(confidence), reasons, versionConflict };
}

export function primaryArtistCreditsOverlap(
  incomingCredits: ReadonlyArray<{ name: string; role: string }>,
  proposedCredits: ReadonlyArray<{ name: string; role: string }>,
): boolean {
  const incomingPrimaryCredits = incomingCredits.filter((credit) => credit.role === "primary");
  const proposedPrimaryCredits = proposedCredits.filter((credit) => credit.role === "primary");
  if (incomingPrimaryCredits.length === 0 || proposedPrimaryCredits.length === 0) return true;
  const incomingPrimaryArtists = normalizedPrimaryArtistNames(incomingPrimaryCredits);
  const proposedPrimaryArtists = normalizedPrimaryArtistNames(proposedPrimaryCredits);
  return [...incomingPrimaryArtists].some((artist) => proposedPrimaryArtists.has(artist));
}

function normalizedPrimaryArtistNames(
  credits: ReadonlyArray<{ name: string; role: string }>,
): Set<string> {
  return new Set(
    credits.map((credit) => {
      const normalized = normalizeText(credit.name);
      const literal = credit.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
      return normalized ? `normalized:${normalized}` : `literal:${literal}`;
    }),
  );
}

function automatic(
  canonicalTrackId: string,
  rule: MatchDecision["rule"],
  confidence: number,
  reasons: string[],
): MatchDecision {
  return { kind: "automatic", rule, confidence, reasons, canonicalTrackId };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
