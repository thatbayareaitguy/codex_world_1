import { createHash } from "node:crypto";
import {
  normalizeAppleIdentityIsrc,
  normalizeAppleIdentityUpc,
  normalizeText,
  resolveAppleMusicArtistFromCatalogEvidence,
  type AppleMusicAlbumCandidate,
  type AppleMusicArtistCandidate,
  type AppleMusicMappingDecision,
  type AppleMusicMappingEvidence,
  type AppleMusicSongCandidate,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import { z } from "zod";
import type { AppleMusicIdentitySeedArtifact } from "./apple-music-identity-seed-artifact";

export const appleMusicStageBDecisionSchemaVersion = 1 as const;
export const appleMusicStageBReviewSchemaVersion = 1 as const;

export type AppleMusicStageBReplayClassification =
  | "offline_auto_resolvable"
  | "requires_live_candidate_evidence"
  | "insufficient_watched_artist_ground_truth"
  | "conflicting_identity_evidence"
  | "manual_review_likely"
  | "candidate_free_manual_review";

export interface AppleMusicStageBSourceRelease {
  canonicalReleaseId: string;
  evidenceCutoff: string;
  evidenceSource: "approved_frozen_spotify_snapshot" | "tracked_sanitized_itunes_evidence";
  releaseDate: string;
  releaseType: string;
  sourceReleaseId: string;
  title: string;
  tracks: Array<{
    durationMs?: number;
    isrc?: string;
    releaseDate?: string;
    title: string;
  }>;
  upc?: string;
  watchedArtistId: string;
}

export interface AppleMusicStageBGroundTruth {
  aliases: string[];
  canonicalName: string;
  evidenceCutoff?: string;
  evidenceSources: string[];
  releases: SpotifyGroundTruthRelease[];
  watchedArtistId: string;
}

export interface AppleMusicStageBCandidateCatalog {
  albums: AppleMusicAlbumCandidate[];
  artist: AppleMusicArtistCandidate;
  evidenceCutoff?: string;
  evidenceSources: string[];
  songs: AppleMusicSongCandidate[];
}

export interface AppleMusicStageBCachedResourceInput {
  albums: AppleMusicAlbumCandidate[];
  artists: AppleMusicArtistCandidate[];
  cacheResponses: unknown[];
  evidenceCutoff?: string;
  songs: AppleMusicSongCandidate[];
}

export interface AppleMusicStageBReplayArtist {
  aliases: string[];
  cadence: AppleMusicStageBCadence;
  candidateCount: number;
  candidatesWithCatalogEvidence: number;
  classification: AppleMusicStageBReplayClassification;
  conflictCount: number;
  decision?: AppleMusicMappingDecision;
  groundTruth: {
    isrcCount: number;
    releaseTitleCount: number;
    trackTitleCount: number;
    upcCount: number;
  };
  watchedArtistId: string;
  canonicalName: string;
}

export interface AppleMusicStageBCadence {
  coverage: "dated_history" | "unavailable";
  mostRecentReleaseDate?: string;
  releases181To365Days: number;
  releases91To180Days: number;
  releasesOlderThan365Days: number;
  releasesWithin90Days: number;
  score: number;
  tier: "high" | "medium" | "low" | "unknown";
}

export interface AppleMusicStageBReplaySummary {
  artists: AppleMusicStageBReplayArtist[];
  coverage: {
    ambiguousArtists: number;
    artistsLackingCandidateCatalogEvidence: number;
    artistsLackingWatchedArtistGroundTruth: number;
    artistsWithCandidateAndGroundTruth: number;
    artistsWithIsrc: number;
    artistsWithReleaseTitles: number;
    artistsWithTrackTitles: number;
    artistsWithUpc: number;
    candidateCatalogIdsAvailable: number;
    candidateFreeArtists: number;
  };
  counts: Record<AppleMusicStageBReplayClassification, number>;
  historicalAppleHttpStartsChanged: false;
  mode: "stage_b_evidence_replay";
  safety: {
    credentialsAccessed: false;
    databaseWrites: 0;
    developerTokenGenerated: false;
    networkRequestsStarted: 0;
    privateKeyAccessed: false;
    providerClientInitialized: false;
  };
}

export interface AppleMusicStageBReviewArtifact {
  artifactSelfHash: string;
  artists: AppleMusicStageBReviewArtist[];
  createdAt: string;
  evidenceCutoff: string;
  schemaVersion: 1;
  sourceArtifactHash: string;
}

export interface AppleMusicStageBReviewArtist {
  aliases: string[];
  cadence: AppleMusicStageBCadence;
  candidates: Array<{
    appleArtistName?: string;
    candidateArtistId: string;
    directPublicAppleUrl: string;
    evidenceCutoff?: string;
    evidenceSources: string[];
    evidenceTier: AppleMusicMappingEvidence["evidenceTier"];
    genreSummary: string[];
    isrcMatches: number;
    isrcState: AppleMusicMappingEvidence["isrcMatchState"];
    nameCompatible: boolean;
    rank: number;
    releaseTitleOverlaps: number;
    score: number;
    trackTitleOverlaps: number;
    upcMatches: number;
    upcState: AppleMusicMappingEvidence["upcMatchState"];
    conflicts: number;
  }>;
  canonicalName: string;
  classification: AppleMusicStageBReplayClassification;
  recommendedAction: "confirm_candidate" | "defer" | "manual_compare";
  watchedArtistId: string;
  winnerMargin?: number;
}

export interface AppleMusicStageBPhase2Batch {
  artistCount: number;
  batchNumber: number;
  candidateIds: number;
  candidateLookupRequests: number;
  candidateRequestsSkippedForInsufficientGroundTruth: number;
  maximumSinglesFallbackRequests: number;
  maximumTopSongsRequests: number;
  proposedRequestCeiling: number;
  proposedRuntimeCeilingMs: number;
  retryHeadroom: number;
}

export interface AppleMusicStageBPhase2Plan {
  allArtifactCandidateIds: number;
  allArtifactCandidateLookupRequests: number;
  ambiguousArtists: number;
  artistsAlreadyOfflineEvaluable: number;
  artistsExpectedToUseIsrc: number;
  artistsExpectedToUseUpc: number;
  artistsLackingGroundTruth: number;
  artistsRequiringSinglesFallback: number;
  artistsRequiringTopSongs: number;
  batches: AppleMusicStageBPhase2Batch[];
  candidateRequestsSkipped: number;
  executionAuthorized: false;
  expectedManualReviewRange: { maximum: number; minimum: number };
  maximumArtistsPerBatch: 50;
  pacingIsProviderAllowance: false;
  proposedMinimumRequestIntervalMs: 1_100;
}

export function buildAppleMusicStageBGroundTruth(
  artifact: AppleMusicIdentitySeedArtifact,
  sourceReleases: AppleMusicStageBSourceRelease[],
): Map<string, AppleMusicStageBGroundTruth> {
  const releases = new Map<string, AppleMusicStageBSourceRelease[]>();
  for (const release of sourceReleases) {
    const existing = releases.get(release.watchedArtistId) ?? [];
    existing.push(release);
    releases.set(release.watchedArtistId, existing);
  }
  return new Map(
    artifact.entries.map((entry) => {
      const source = (releases.get(entry.watchedArtistId) ?? []).sort(compareSourceRelease);
      const evidenceSources = [...new Set(source.map((release) => release.evidenceSource))].sort();
      const evidenceCutoff = source
        .map((release) => release.evidenceCutoff)
        .sort()
        .at(-1);
      const normalized = deduplicateGroundTruthReleases(source);
      return [
        entry.watchedArtistId,
        {
          aliases: [...entry.aliases].sort(),
          canonicalName: entry.canonicalArtistName,
          ...(evidenceCutoff ? { evidenceCutoff } : {}),
          evidenceSources,
          releases: normalized,
          watchedArtistId: entry.watchedArtistId,
        },
      ];
    }),
  );
}

export function extractAppleMusicStageBCandidateCatalogs(
  input: AppleMusicStageBCachedResourceInput,
  allowedCandidateIds: Set<string>,
): Map<string, AppleMusicStageBCandidateCatalog> {
  const artists = new Map<string, AppleMusicArtistCandidate>();
  const albums: AppleMusicAlbumCandidate[] = [...input.albums];
  const songs: AppleMusicSongCandidate[] = [...input.songs];
  for (const artist of input.artists) {
    if (allowedCandidateIds.has(artist.artistId)) artists.set(artist.artistId, artist);
  }
  for (const response of input.cacheResponses) {
    for (const resource of cachedResources(response)) {
      if (resource.type === "artists" && allowedCandidateIds.has(resource.id)) {
        const name = stringAttribute(resource, "name");
        if (!name) continue;
        artists.set(resource.id, {
          artistId: resource.id,
          genreNames: stringArrayAttribute(resource, "genreNames"),
          name,
        });
      }
      if (resource.type === "albums") {
        const normalized = cachedAlbum(resource);
        if (normalized) albums.push(normalized);
      }
      if (resource.type === "songs") {
        const normalized = cachedSong(resource);
        if (normalized) songs.push(normalized);
      }
    }
  }
  for (const item of [...albums, ...songs]) {
    for (const artistId of item.artistIds) {
      if (!allowedCandidateIds.has(artistId) || artists.has(artistId)) continue;
      artists.set(artistId, { artistId, name: item.artistName });
    }
  }
  const result = new Map<string, AppleMusicStageBCandidateCatalog>();
  for (const [artistId, artist] of artists) {
    const artistAlbums = deduplicateAlbums(
      albums.filter((album) => album.artistIds.includes(artistId)),
    );
    const artistSongs = deduplicateSongs(songs.filter((song) => song.artistIds.includes(artistId)));
    if (artistAlbums.length === 0 && artistSongs.length === 0) continue;
    result.set(artistId, {
      albums: artistAlbums,
      artist,
      ...(input.evidenceCutoff ? { evidenceCutoff: input.evidenceCutoff } : {}),
      evidenceSources: ["existing_sanitized_apple_database_and_cache"],
      songs: artistSongs,
    });
  }
  return result;
}

export function replayAppleMusicStageB(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  candidateCatalogs: Map<string, AppleMusicStageBCandidateCatalog>;
  groundTruth: Map<string, AppleMusicStageBGroundTruth>;
  now: Date;
}): AppleMusicStageBReplaySummary {
  const ambiguous = input.artifact.entries.filter(
    (entry) => entry.classification === "ambiguous_seed",
  );
  const candidateFree = input.artifact.entries.filter(
    (entry) =>
      entry.classification === "manual_review_required" &&
      !entry.candidateArtistId &&
      entry.alternateCandidateIds.length === 0,
  );
  const artists: AppleMusicStageBReplayArtist[] = ambiguous.map((entry) => {
    const groundTruth = requiredGroundTruth(input.groundTruth, entry.watchedArtistId);
    const candidateIds = candidateIdsForEntry(entry);
    const available = candidateIds.flatMap((id) => {
      const catalog = input.candidateCatalogs.get(id);
      return catalog ? [catalog] : [];
    });
    const cadence = calculateAppleMusicStageBCadence(groundTruth.releases, input.now);
    const coverage = groundTruthCoverage(groundTruth.releases);
    let classification: AppleMusicStageBReplayClassification;
    let decision: AppleMusicMappingDecision | undefined;
    if (groundTruth.releases.length === 0) {
      classification = "insufficient_watched_artist_ground_truth";
    } else if (available.length !== candidateIds.length) {
      classification = "requires_live_candidate_evidence";
    } else {
      decision = resolveAppleMusicArtistFromCatalogEvidence({
        aliases: entry.aliases,
        candidateCatalogs: available,
        canonicalName: entry.canonicalArtistName,
        groundTruth: groundTruth.releases,
      });
      classification = decision.selected
        ? "offline_auto_resolvable"
        : decision.reason.includes("point to different candidates") ||
            decision.evidence.some(
              (evidence) =>
                evidence.contradictoryIsrcCount > 0 || evidence.contradictoryUpcCount > 0,
            )
          ? "conflicting_identity_evidence"
          : "manual_review_likely";
    }
    return {
      aliases: entry.aliases,
      cadence,
      candidateCount: candidateIds.length,
      candidatesWithCatalogEvidence: available.length,
      canonicalName: entry.canonicalArtistName,
      classification,
      conflictCount:
        decision?.evidence.reduce(
          (total, evidence) =>
            total +
            evidence.conflictingReleaseTitles.length +
            evidence.contradictoryIsrcCount +
            evidence.contradictoryUpcCount,
          0,
        ) ?? 0,
      ...(decision ? { decision } : {}),
      groundTruth: coverage,
      watchedArtistId: entry.watchedArtistId,
    } satisfies AppleMusicStageBReplayArtist;
  });
  for (const entry of candidateFree) {
    const groundTruth = requiredGroundTruth(input.groundTruth, entry.watchedArtistId);
    artists.push({
      aliases: entry.aliases,
      cadence: calculateAppleMusicStageBCadence(groundTruth.releases, input.now),
      candidateCount: 0,
      candidatesWithCatalogEvidence: 0,
      canonicalName: entry.canonicalArtistName,
      classification: "candidate_free_manual_review",
      conflictCount: 0,
      groundTruth: groundTruthCoverage(groundTruth.releases),
      watchedArtistId: entry.watchedArtistId,
    });
  }
  const counts = emptyReplayCounts();
  for (const artist of artists) counts[artist.classification] += 1;
  const ambiguousArtists = artists.filter(
    (artist) => artist.classification !== "candidate_free_manual_review",
  );
  const ambiguousCandidateIds = new Set(ambiguous.flatMap(candidateIdsForEntry));
  return {
    artists: artists.sort(compareReplayArtist),
    counts,
    coverage: {
      ambiguousArtists: ambiguous.length,
      artistsLackingCandidateCatalogEvidence: ambiguousArtists.filter(
        (artist) => artist.candidatesWithCatalogEvidence < artist.candidateCount,
      ).length,
      artistsLackingWatchedArtistGroundTruth: ambiguousArtists.filter(
        (artist) => artist.groundTruth.releaseTitleCount === 0,
      ).length,
      artistsWithCandidateAndGroundTruth: ambiguousArtists.filter(
        (artist) =>
          artist.candidatesWithCatalogEvidence === artist.candidateCount &&
          artist.groundTruth.releaseTitleCount > 0,
      ).length,
      artistsWithIsrc: ambiguousArtists.filter((artist) => artist.groundTruth.isrcCount > 0).length,
      artistsWithReleaseTitles: ambiguousArtists.filter(
        (artist) => artist.groundTruth.releaseTitleCount > 0,
      ).length,
      artistsWithTrackTitles: ambiguousArtists.filter(
        (artist) => artist.groundTruth.trackTitleCount > 0,
      ).length,
      artistsWithUpc: ambiguousArtists.filter((artist) => artist.groundTruth.upcCount > 0).length,
      candidateCatalogIdsAvailable: [...ambiguousCandidateIds].filter((id) =>
        input.candidateCatalogs.has(id),
      ).length,
      candidateFreeArtists: candidateFree.length,
    },
    historicalAppleHttpStartsChanged: false,
    mode: "stage_b_evidence_replay",
    safety: {
      credentialsAccessed: false,
      databaseWrites: 0,
      developerTokenGenerated: false,
      networkRequestsStarted: 0,
      privateKeyAccessed: false,
      providerClientInitialized: false,
    },
  };
}

export function calculateAppleMusicStageBCadence(
  releases: SpotifyGroundTruthRelease[],
  now: Date,
): AppleMusicStageBCadence {
  const ages = releases.flatMap((release) => {
    const timestamp = Date.parse(release.releaseDate.slice(0, 10));
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return [];
    return [Math.floor((now.getTime() - timestamp) / 86_400_000)];
  });
  if (ages.length === 0) {
    return {
      coverage: "unavailable",
      releases181To365Days: 0,
      releases91To180Days: 0,
      releasesOlderThan365Days: 0,
      releasesWithin90Days: 0,
      score: 0,
      tier: "unknown",
    };
  }
  const within90 = ages.filter((age) => age <= 90).length;
  const days91To180 = ages.filter((age) => age >= 91 && age <= 180).length;
  const days181To365 = ages.filter((age) => age >= 181 && age <= 365).length;
  const older = ages.filter((age) => age > 365).length;
  const score = within90 * 8 + days91To180 * 4 + days181To365 * 2 + older;
  const mostRecentReleaseDate = releases
    .map((release) => release.releaseDate.slice(0, 10))
    .sort()
    .at(-1);
  return {
    coverage: "dated_history",
    ...(mostRecentReleaseDate ? { mostRecentReleaseDate } : {}),
    releases181To365Days: days181To365,
    releases91To180Days: days91To180,
    releasesOlderThan365Days: older,
    releasesWithin90Days: within90,
    score,
    tier: score >= 24 ? "high" : score >= 8 ? "medium" : "low",
  };
}

export function createAppleMusicStageBReviewArtifact(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  candidateCatalogs: Map<string, AppleMusicStageBCandidateCatalog>;
  createdAt: Date;
  replay: AppleMusicStageBReplaySummary;
}): AppleMusicStageBReviewArtifact {
  const replayById = new Map(
    input.replay.artists.map((artist) => [artist.watchedArtistId, artist]),
  );
  const artists = input.artifact.entries
    .filter(
      (entry) =>
        entry.classification === "ambiguous_seed" ||
        entry.classification === "manual_review_required",
    )
    .map((entry) => {
      const replay = requiredReplayArtist(replayById, entry.watchedArtistId);
      const evidenceById = new Map(
        (replay.decision?.evidence ?? []).map((evidence) => [evidence.artistId, evidence]),
      );
      const candidates = candidateIdsForEntry(entry)
        .map((candidateArtistId) => {
          const catalog = input.candidateCatalogs.get(candidateArtistId);
          const evidence = evidenceById.get(candidateArtistId);
          return {
            ...(catalog ? { appleArtistName: catalog.artist.name } : {}),
            candidateArtistId,
            directPublicAppleUrl: `https://music.apple.com/us/artist/${candidateArtistId}`,
            ...(catalog?.evidenceCutoff ? { evidenceCutoff: catalog.evidenceCutoff } : {}),
            evidenceSources: catalog?.evidenceSources ?? [],
            evidenceTier: evidence?.evidenceTier ?? "none",
            genreSummary: catalog?.artist.genreNames?.slice(0, 5) ?? [],
            isrcMatches: evidence?.exactIsrcMatchCount ?? 0,
            isrcState: evidence?.isrcMatchState ?? "no_signal",
            nameCompatible: evidence?.nameCompatible ?? false,
            rank: 0,
            releaseTitleOverlaps: evidence?.exactReleaseTitles.length ?? 0,
            score: evidence?.score ?? 0,
            trackTitleOverlaps: evidence?.exactTrackTitles.length ?? 0,
            upcMatches: evidence?.exactUpcMatchCount ?? 0,
            upcState: evidence?.upcMatchState ?? "no_signal",
            conflicts:
              (evidence?.conflictingReleaseTitles.length ?? 0) +
              (evidence?.contradictoryIsrcCount ?? 0) +
              (evidence?.contradictoryUpcCount ?? 0),
          };
        })
        .sort(compareReviewCandidate)
        .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
      const winnerMargin =
        candidates.length > 0 ? candidates[0]!.score - (candidates[1]?.score ?? 0) : undefined;
      return {
        aliases: entry.aliases,
        cadence: replay.cadence,
        candidates,
        canonicalName: entry.canonicalArtistName,
        classification: replay.classification,
        recommendedAction:
          replay.classification === "offline_auto_resolvable"
            ? "confirm_candidate"
            : replay.classification === "candidate_free_manual_review"
              ? "defer"
              : "manual_compare",
        watchedArtistId: entry.watchedArtistId,
        ...(winnerMargin === undefined ? {} : { winnerMargin }),
      } satisfies AppleMusicStageBReviewArtist;
    })
    .sort(compareReviewArtist);
  const withoutHash = {
    artists,
    createdAt: input.createdAt.toISOString(),
    evidenceCutoff: input.artifact.evidenceCutoffDate,
    schemaVersion: appleMusicStageBReviewSchemaVersion,
    sourceArtifactHash: input.artifact.artifactSelfHash,
  };
  return { artifactSelfHash: sha256(canonicalJson(withoutHash)), ...withoutHash };
}

const manualDecisionSchema = z
  .object({
    artifactSelfHash: z.string().regex(/^[a-f0-9]{64}$/),
    decisions: z.array(
      z
        .object({
          decision: z.enum(["confirm", "reject", "defer"]),
          decidedAt: z.string().datetime({ offset: true }),
          humanEvidenceNote: z.string().trim().min(1).max(1000).optional(),
          selectedCandidateId: z
            .string()
            .regex(/^\d{1,30}$/)
            .optional(),
          watchedArtistId: z.string().uuid(),
        })
        .strict(),
    ),
    reviewArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    schemaVersion: z.literal(appleMusicStageBDecisionSchemaVersion),
  })
  .strict();

export type AppleMusicStageBManualDecisionArtifact = z.infer<typeof manualDecisionSchema>;

export function parseAppleMusicStageBManualDecisionArtifact(
  value: unknown,
  review: AppleMusicStageBReviewArtifact,
): AppleMusicStageBManualDecisionArtifact {
  const artifact = manualDecisionSchema.parse(value);
  if (artifact.reviewArtifactHash !== review.artifactSelfHash) {
    throw new Error("Apple Stage B decision artifact targets a different review version.");
  }
  const byArtist = new Map(review.artists.map((artist) => [artist.watchedArtistId, artist]));
  if (
    new Set(artifact.decisions.map((decision) => decision.watchedArtistId)).size !==
    artifact.decisions.length
  ) {
    throw new Error("Apple Stage B decision artifact contains duplicate watched artists.");
  }
  for (const decision of artifact.decisions) {
    const artist = byArtist.get(decision.watchedArtistId);
    if (!artist) throw new Error("Apple Stage B decision references an unknown watched artist.");
    if (decision.decision === "defer" && decision.selectedCandidateId) {
      throw new Error("A deferred Apple Stage B decision cannot select a candidate.");
    }
    if (decision.decision !== "defer" && !decision.selectedCandidateId) {
      throw new Error("A confirm or reject Apple Stage B decision requires a candidate.");
    }
    if (
      decision.selectedCandidateId &&
      !artist.candidates.some(
        (candidate) => candidate.candidateArtistId === decision.selectedCandidateId,
      )
    ) {
      throw new Error("Apple Stage B decision selected a candidate outside the bound review.");
    }
  }
  const content: Record<string, unknown> = { ...artifact };
  Reflect.deleteProperty(content, "artifactSelfHash");
  if (sha256(canonicalJson(content)) !== artifact.artifactSelfHash) {
    throw new Error("Apple Stage B decision artifact hash validation failed.");
  }
  return artifact;
}

export function createAppleMusicStageBManualDecisionArtifact(input: {
  decisions: AppleMusicStageBManualDecisionArtifact["decisions"];
  reviewArtifactHash: string;
}): AppleMusicStageBManualDecisionArtifact {
  const withoutHash = {
    decisions: input.decisions,
    reviewArtifactHash: input.reviewArtifactHash,
    schemaVersion: appleMusicStageBDecisionSchemaVersion,
  };
  return { artifactSelfHash: sha256(canonicalJson(withoutHash)), ...withoutHash };
}

export function createAppleMusicStageBReviewHtml(review: AppleMusicStageBReviewArtifact): string {
  const rows = review.artists.map((artist) => {
    const options = artist.candidates
      .map(
        (candidate) =>
          `<option value="${escapeHtml(candidate.candidateArtistId)}">#${candidate.rank} ${escapeHtml(candidate.appleArtistName ?? "Name not cached")} | tier ${escapeHtml(candidate.evidenceTier)} | score ${candidate.score}</option>`,
      )
      .join("");
    const evidence = artist.candidates
      .map(
        (candidate) =>
          `<li><a href="${escapeHtml(candidate.directPublicAppleUrl)}" target="_blank" rel="noreferrer">Candidate ${candidate.rank}</a>: name ${candidate.nameCompatible ? "compatible" : "unverified"}, ISRC ${candidate.isrcMatches}, UPC ${candidate.upcMatches}, releases ${candidate.releaseTitleOverlaps}, tracks ${candidate.trackTitleOverlaps}, conflicts ${candidate.conflicts}</li>`,
      )
      .join("");
    return `<section class="artist" data-artist="${escapeHtml(artist.watchedArtistId)}"><h2>${escapeHtml(artist.canonicalName)}</h2><p>Cadence: ${escapeHtml(artist.cadence.tier)} (${artist.cadence.score}); replay: ${escapeHtml(artist.classification)}</p><ul>${evidence || "<li>No bounded candidate is available.</li>"}</ul><label>Candidate <select class="candidate"><option value="">None</option>${options}</select></label><label><input type="radio" name="decision-${escapeHtml(artist.watchedArtistId)}" value="confirm"> Confirm</label><label><input type="radio" name="decision-${escapeHtml(artist.watchedArtistId)}" value="reject"> Reject</label><label><input type="radio" name="decision-${escapeHtml(artist.watchedArtistId)}" value="defer" checked> Defer</label><label>Evidence note <input class="note" maxlength="1000"></label></section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Apple Music Stage B assisted review</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:2rem;background:#fafafa;color:#171717}.artist{background:white;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}label{display:inline-block;margin:.5rem 1rem .5rem 0}input.note{min-width:24rem}button{padding:.7rem 1rem}</style></head><body><h1>Apple Music Stage B assisted review</h1><p>Review version <code>${escapeHtml(review.artifactSelfHash)}</code>. This ignored local page contains public catalog IDs. It does not apply decisions.</p><button id="download">Download decision artifact</button>${rows.join("")}<script>const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');document.querySelector('#download').addEventListener('click',async()=>{const decisions=[...document.querySelectorAll('.artist')].map(row=>{const decision=row.querySelector('input[type=radio]:checked').value;const selectedCandidateId=row.querySelector('.candidate').value||undefined;const humanEvidenceNote=row.querySelector('.note').value.trim()||undefined;return{decision,decidedAt:new Date().toISOString(),...(humanEvidenceNote?{humanEvidenceNote}:{}),...(decision!=='defer'&&selectedCandidateId?{selectedCandidateId}:{}),watchedArtistId:row.dataset.artist}});const base={decisions,reviewArtifactHash:'${escapeHtml(review.artifactSelfHash)}',schemaVersion:1};const artifactSelfHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(base))));const blob=new Blob([JSON.stringify({artifactSelfHash,...base},null,2)+'\n'],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='apple-music-stage-b-decisions.json';a.click();URL.revokeObjectURL(a.href)});</script></body></html>\n`;
}

export function createAppleMusicStageBPhase2Plan(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  candidateCatalogs: Map<string, AppleMusicStageBCandidateCatalog>;
  replay: AppleMusicStageBReplaySummary;
}): AppleMusicStageBPhase2Plan {
  const replayById = new Map(
    input.replay.artists.map((artist) => [artist.watchedArtistId, artist]),
  );
  const entries = input.artifact.entries
    .filter((entry) => entry.classification === "ambiguous_seed")
    .sort((left, right) => {
      const a = requiredReplayArtist(replayById, left.watchedArtistId);
      const b = requiredReplayArtist(replayById, right.watchedArtistId);
      return compareReplayArtist(a, b);
    });
  const eligibleEntries = entries.filter((entry) => {
    const replay = requiredReplayArtist(replayById, entry.watchedArtistId);
    return (
      replay.groundTruth.releaseTitleCount > 0 &&
      replay.classification !== "offline_auto_resolvable"
    );
  });
  const batches = chunk(eligibleEntries, 50).map((batch, index) => {
    const candidates = batch.reduce(
      (total, entry) => total + candidateIdsForEntry(entry).length,
      0,
    );
    const eligibleCandidateIds = batch.flatMap(candidateIdsForEntry);
    const uncachedArtistIds = eligibleCandidateIds.filter(
      (id) => !input.candidateCatalogs.get(id)?.artist.name,
    );
    const missingCatalogIds = eligibleCandidateIds.filter((id) => !input.candidateCatalogs.has(id));
    const candidateLookupRequests = Math.ceil(uncachedArtistIds.length / 25);
    const maximumTopSongsRequests = missingCatalogIds.length;
    const maximumSinglesFallbackRequests = missingCatalogIds.length;
    const baseRequests =
      candidateLookupRequests + maximumTopSongsRequests + maximumSinglesFallbackRequests;
    const retryHeadroom = baseRequests === 0 ? 0 : Math.max(2, Math.ceil(baseRequests * 0.1));
    const proposedRequestCeiling = baseRequests + retryHeadroom;
    return {
      artistCount: batch.length,
      batchNumber: index + 1,
      candidateIds: candidates,
      candidateLookupRequests,
      candidateRequestsSkippedForInsufficientGroundTruth: 0,
      maximumSinglesFallbackRequests,
      maximumTopSongsRequests,
      proposedRequestCeiling,
      proposedRuntimeCeilingMs:
        proposedRequestCeiling === 0
          ? 0
          : Math.min(3_600_000, proposedRequestCeiling * 1_100 + 60_000),
      retryHeadroom,
    };
  });
  const allArtifactCandidateIds = entries.reduce(
    (total, entry) => total + candidateIdsForEntry(entry).length,
    0,
  );
  const liveCandidateIds = eligibleEntries.reduce(
    (total, entry) => total + candidateIdsForEntry(entry).length,
    0,
  );
  const minimumManualReview =
    input.replay.coverage.artistsLackingWatchedArtistGroundTruth +
    input.replay.coverage.candidateFreeArtists +
    input.replay.counts.conflicting_identity_evidence +
    input.replay.counts.manual_review_likely;
  return {
    allArtifactCandidateIds,
    allArtifactCandidateLookupRequests: Math.ceil(allArtifactCandidateIds / 25),
    ambiguousArtists: entries.length,
    artistsAlreadyOfflineEvaluable: input.replay.coverage.artistsWithCandidateAndGroundTruth,
    artistsExpectedToUseIsrc: input.replay.coverage.artistsWithIsrc,
    artistsExpectedToUseUpc: input.replay.coverage.artistsWithUpc,
    artistsLackingGroundTruth: input.replay.coverage.artistsLackingWatchedArtistGroundTruth,
    artistsRequiringSinglesFallback: eligibleEntries.length,
    artistsRequiringTopSongs: eligibleEntries.length,
    batches,
    candidateRequestsSkipped: allArtifactCandidateIds - liveCandidateIds,
    executionAuthorized: false,
    expectedManualReviewRange: {
      maximum: minimumManualReview + eligibleEntries.length,
      minimum: minimumManualReview,
    },
    maximumArtistsPerBatch: 50,
    pacingIsProviderAllowance: false,
    proposedMinimumRequestIntervalMs: 1_100,
  };
}

function deduplicateGroundTruthReleases(
  source: AppleMusicStageBSourceRelease[],
): SpotifyGroundTruthRelease[] {
  const releases = new Map<string, SpotifyGroundTruthRelease>();
  for (const release of source) {
    const upc = normalizeAppleIdentityUpc(release.upc);
    const releaseKey = [normalizeText(release.title), release.releaseDate, upc ?? ""].join("|");
    const existing = releases.get(releaseKey);
    const tracks = new Map<string, NonNullable<SpotifyGroundTruthRelease["tracks"]>[number]>();
    for (const track of existing?.tracks ?? []) {
      tracks.set(
        [track.normalizedTitle, track.releaseDate ?? release.releaseDate, track.isrc ?? ""].join(
          "|",
        ),
        track,
      );
    }
    for (const track of release.tracks) {
      const isrc = normalizeAppleIdentityIsrc(track.isrc);
      const key = [
        normalizeText(track.title),
        track.releaseDate ?? release.releaseDate,
        isrc ?? "",
      ].join("|");
      tracks.set(key, {
        ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
        ...(isrc ? { isrc } : {}),
        normalizedTitle: normalizeText(track.title),
        ...(track.releaseDate ? { releaseDate: track.releaseDate } : {}),
        title: track.title.trim(),
      });
    }
    releases.set(releaseKey, {
      canonicalReleaseId: existing?.canonicalReleaseId ?? release.canonicalReleaseId,
      evidenceCutoff: [existing?.evidenceCutoff, release.evidenceCutoff]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1)!,
      evidenceSource: existing?.evidenceSource ?? release.evidenceSource,
      normalizedTitle: normalizeText(release.title),
      releaseDate: release.releaseDate.slice(0, 10),
      releaseType: release.releaseType,
      spotifyReleaseId: existing?.spotifyReleaseId ?? release.sourceReleaseId,
      title: release.title.trim(),
      tracks: [...tracks.values()].sort((a, b) =>
        [a.normalizedTitle, a.isrc ?? ""]
          .join("|")
          .localeCompare([b.normalizedTitle, b.isrc ?? ""].join("|")),
      ),
      ...(upc ? { upc } : {}),
    });
  }
  return [...releases.values()].sort((a, b) =>
    [a.releaseDate, a.normalizedTitle, a.upc ?? ""]
      .join("|")
      .localeCompare([b.releaseDate, b.normalizedTitle, b.upc ?? ""].join("|")),
  );
}

interface CachedResource {
  attributes?: Record<string, unknown>;
  id: string;
  relationships?: Record<string, unknown>;
  type: string;
}

function cachedResources(value: unknown): CachedResource[] {
  if (!isRecord(value)) return [];
  const collections: unknown[] = [];
  if (Array.isArray(value.data)) {
    const data = value.data as unknown[];
    collections.push(...data);
  }
  if (isRecord(value.results)) {
    for (const result of Object.values(value.results)) {
      if (isRecord(result) && Array.isArray(result.data)) {
        const data = result.data as unknown[];
        collections.push(...data);
      }
    }
  }
  return collections.filter(isCachedResource);
}

function cachedAlbum(resource: CachedResource): AppleMusicAlbumCandidate | undefined {
  const artistName = stringAttribute(resource, "artistName");
  const title = stringAttribute(resource, "name");
  if (!artistName || !title) return undefined;
  const releaseDate = stringAttribute(resource, "releaseDate");
  const trackCount = numberAttribute(resource, "trackCount");
  const upc = normalizeAppleIdentityUpc(stringAttribute(resource, "upc"));
  return {
    albumId: resource.id,
    artistIds: relationshipIds(resource, "artists"),
    artistName,
    paginationPath: "offline-sanitized-cache",
    pageNumber: 1,
    ...(releaseDate ? { releaseDate } : {}),
    sourceView: "album",
    title,
    ...(trackCount === undefined ? {} : { trackCount }),
    ...(upc ? { upc } : {}),
  };
}

function cachedSong(resource: CachedResource): AppleMusicSongCandidate | undefined {
  const artistName = stringAttribute(resource, "artistName");
  const title = stringAttribute(resource, "name");
  if (!artistName || !title) return undefined;
  const albumId = relationshipIds(resource, "albums")[0];
  const albumTitle = stringAttribute(resource, "albumName");
  const discNumber = numberAttribute(resource, "discNumber");
  const durationMs = numberAttribute(resource, "durationInMillis");
  const isrc = normalizeAppleIdentityIsrc(stringAttribute(resource, "isrc"));
  const releaseDate = stringAttribute(resource, "releaseDate");
  const trackNumber = numberAttribute(resource, "trackNumber");
  return {
    ...(albumId ? { albumId } : {}),
    ...(albumTitle ? { albumTitle } : {}),
    artistIds: relationshipIds(resource, "artists"),
    artistName,
    ...(discNumber === undefined ? {} : { discNumber }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(isrc ? { isrc } : {}),
    paginationPath: "offline-sanitized-cache",
    pageNumber: 1,
    ...(releaseDate ? { releaseDate } : {}),
    songId: resource.id,
    title,
    ...(trackNumber === undefined ? {} : { trackNumber }),
  };
}

function relationshipIds(resource: CachedResource, name: string): string[] {
  const relationship = resource.relationships?.[name];
  if (!isRecord(relationship) || !Array.isArray(relationship.data)) return [];
  return relationship.data.flatMap((value) =>
    isRecord(value) && typeof value.id === "string" ? [value.id] : [],
  );
}

function stringAttribute(resource: CachedResource, name: string): string | undefined {
  const value = resource.attributes?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayAttribute(resource: CachedResource, name: string): string[] {
  const value = resource.attributes?.[name];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberAttribute(resource: CachedResource, name: string): number | undefined {
  const value = resource.attributes?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isCachedResource(value: unknown): value is CachedResource {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    (!value.attributes || isRecord(value.attributes)) &&
    (!value.relationships || isRecord(value.relationships))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function groundTruthCoverage(releases: SpotifyGroundTruthRelease[]) {
  return {
    isrcCount: new Set(
      releases
        .flatMap((release) => release.tracks ?? [])
        .map((track) => normalizeAppleIdentityIsrc(track.isrc))
        .filter((value): value is string => Boolean(value)),
    ).size,
    releaseTitleCount: new Set(releases.map((release) => normalizeText(release.title))).size,
    trackTitleCount: new Set(
      releases
        .flatMap((release) => release.tracks ?? [])
        .map((track) => normalizeText(track.title)),
    ).size,
    upcCount: new Set(
      releases
        .map((release) => normalizeAppleIdentityUpc(release.upc))
        .filter((value): value is string => Boolean(value)),
    ).size,
  };
}

function emptyReplayCounts(): Record<AppleMusicStageBReplayClassification, number> {
  return {
    candidate_free_manual_review: 0,
    conflicting_identity_evidence: 0,
    insufficient_watched_artist_ground_truth: 0,
    manual_review_likely: 0,
    offline_auto_resolvable: 0,
    requires_live_candidate_evidence: 0,
  };
}

function compareSourceRelease(
  left: AppleMusicStageBSourceRelease,
  right: AppleMusicStageBSourceRelease,
) {
  return [left.releaseDate, normalizeText(left.title), left.sourceReleaseId]
    .join("|")
    .localeCompare(
      [right.releaseDate, normalizeText(right.title), right.sourceReleaseId].join("|"),
    );
}

function compareReplayArtist(
  left: AppleMusicStageBReplayArtist,
  right: AppleMusicStageBReplayArtist,
) {
  return (
    right.cadence.score - left.cadence.score ||
    normalizeText(left.canonicalName).localeCompare(normalizeText(right.canonicalName)) ||
    left.watchedArtistId.localeCompare(right.watchedArtistId)
  );
}

function compareReviewArtist(
  left: AppleMusicStageBReviewArtist,
  right: AppleMusicStageBReviewArtist,
) {
  return (
    right.cadence.score - left.cadence.score ||
    normalizeText(left.canonicalName).localeCompare(normalizeText(right.canonicalName)) ||
    left.watchedArtistId.localeCompare(right.watchedArtistId)
  );
}

function compareReviewCandidate(
  left: AppleMusicStageBReviewArtist["candidates"][number],
  right: AppleMusicStageBReviewArtist["candidates"][number],
) {
  return (
    evidenceTierRank(right.evidenceTier) - evidenceTierRank(left.evidenceTier) ||
    right.score - left.score ||
    left.candidateArtistId.localeCompare(right.candidateArtistId)
  );
}

function evidenceTierRank(tier: AppleMusicMappingEvidence["evidenceTier"]): number {
  return { code_conflict: 0, isrc_exact: 4, none: 1, title_overlap: 2, upc_exact: 3 }[tier];
}

function deduplicateAlbums(albums: AppleMusicAlbumCandidate[]): AppleMusicAlbumCandidate[] {
  return [
    ...new Map(albums.map((album) => [`${album.albumId}:${album.sourceView}`, album])).values(),
  ].sort((a, b) => a.albumId.localeCompare(b.albumId));
}

function deduplicateSongs(songs: AppleMusicSongCandidate[]): AppleMusicSongCandidate[] {
  return [...new Map(songs.map((song) => [song.songId, song])).values()].sort((a, b) =>
    a.songId.localeCompare(b.songId),
  );
}

function requiredGroundTruth(
  source: Map<string, AppleMusicStageBGroundTruth>,
  watchedArtistId: string,
): AppleMusicStageBGroundTruth {
  const value = source.get(watchedArtistId);
  if (!value) throw new Error("Apple Stage B ground truth omitted a watched artist.");
  return value;
}

function requiredReplayArtist(
  source: Map<string, AppleMusicStageBReplayArtist>,
  watchedArtistId: string,
): AppleMusicStageBReplayArtist {
  const value = source.get(watchedArtistId);
  if (!value) throw new Error("Apple Stage B replay omitted a review artist.");
  return value;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

function candidateIdsForEntry(entry: AppleMusicIdentitySeedArtifact["entries"][number]): string[] {
  return [
    ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
    ...entry.alternateCandidateIds,
  ];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
