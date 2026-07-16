import { extractVersion, normalizeIdentifier, normalizeText, normalizedCredits } from "./normalize";
import type { CanonicalTrack, MatchDecision, TrackCandidate } from "./types";

const AUTOMATIC_THRESHOLD = 0.93;
const DURATION_TOLERANCE_MS = 2_000;

export function matchCandidate(
  candidate: TrackCandidate,
  tracks: readonly CanonicalTrack[],
): MatchDecision {
  if (candidate.isrc) {
    const normalized = normalizeIdentifier(candidate.isrc);
    const exact = tracks.find(
      (track) => track.isrc && normalizeIdentifier(track.isrc) === normalized,
    );
    if (exact) {
      return automatic(exact.id, "exact_isrc", 1, [`ISRC ${normalized} is identical`]);
    }
  }

  const barcode = candidate.upc ?? candidate.ean;
  if (barcode && candidate.trackNumber) {
    const normalized = normalizeIdentifier(barcode);
    const exact = tracks.find((track) => {
      const trackBarcode = track.upc ?? track.ean;
      return (
        trackBarcode !== undefined &&
        normalizeIdentifier(trackBarcode) === normalized &&
        track.trackNumber === candidate.trackNumber &&
        (track.discNumber ?? 1) === (candidate.discNumber ?? 1)
      );
    });
    if (exact) {
      return automatic(exact.id, "exact_barcode_position", 0.99, [
        "Barcode, disc, and track position are identical",
      ]);
    }
  }

  const mbExact = tracks.find(
    (track) =>
      (candidate.musicbrainzRecordingId &&
        track.musicbrainzRecordingId === candidate.musicbrainzRecordingId) ||
      (candidate.musicbrainzReleaseGroupId &&
        track.musicbrainzReleaseGroupId === candidate.musicbrainzReleaseGroupId),
  );
  if (mbExact) {
    return automatic(mbExact.id, "exact_musicbrainz", 0.98, [
      "MusicBrainz recording or release-group identifier is identical",
    ]);
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

function scoreMetadata(candidate: TrackCandidate, track: CanonicalTrack) {
  let confidence = 0;
  const reasons: string[] = [];
  const candidateTitle = normalizeText(candidate.title);
  const titleEqual = candidateTitle === track.normalizedTitle;
  if (!titleEqual) return { track, confidence, reasons, versionConflict: false };

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
