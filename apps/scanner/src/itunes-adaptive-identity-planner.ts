import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeText } from "@radar/core";
import type { CensusArtifactArtist, CensusResultArtifact } from "./itunes-search-census-artifact";
import {
  readHistoricalIdentityEvidence,
  type HistoricalIdentityArtist,
  type HistoricalIdentityEvidenceSnapshot,
  type HistoricalIdentityRelease,
} from "./itunes-historical-identity-evidence";

export const adaptiveCensusFileSha256 =
  "ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa";
export const adaptiveCensusCanonicalSha256 =
  "8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d";
export const adaptivePilotSnapshotSha256 =
  "48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a";
export const adaptiveHistoricalEvidenceCutoff = "2026-07-30T02:10:30.000Z";
export const adaptivePacingMs = 3_200;
export const adaptiveRequestLimit = 150;
export const adaptiveArtistLimit = 50;

const genericTitles = new Set([
  "alive",
  "dream",
  "forever",
  "home",
  "intro",
  "interlude",
  "love",
  "outro",
  "run",
  "stay",
  "tonight",
  "you",
]);
const weakVersionMarkers = new Set(["edit", "live", "mix", "remaster", "remix", "vip"]);

export type AnchorQuality = "strong" | "moderate" | "weak" | "unusable";

export interface HistoricalAnchorScore {
  excludedEvidence: string[];
  exclusionReasons: string[];
  includedEvidence: string[];
  normalizedTitle: string;
  originalTitle: string;
  quality: AnchorQuality;
  releaseDate: string;
  releaseType: string;
  score: number;
  selectionOrder: number;
  spotifyReleaseId: string;
  versionMarkers: string[];
}

export interface ArtistHistoricalScore {
  anchorQuality: AnchorQuality;
  anchorScore: number;
  anchors: HistoricalAnchorScore[];
  completeReleaseCount: number;
  distinctiveTrackTitles: boolean;
  earliestUsableEvidenceDate: string;
  exactHistoricalReleaseTitles: boolean;
  featureOnlyEvidence: boolean;
  hasAlbumOrEpEvidence: boolean;
  historicalReleaseCount: number;
  historicalTrackCount: number;
  latestUsableEvidenceDate: string;
  noUsableHistoricalEvidence: boolean;
  remixOnlyEvidence: boolean;
  singleOnlyEvidence: boolean;
  usableAnchorCount: number;
}

export interface IdentityEvidenceInventoryRow extends ArtistHistoricalScore {
  canonicalArtistId: string;
  canonicalName: string;
  plausibleAppleCandidateCount: number;
  resultLimitReached: boolean;
  searchStageMappingState: string;
}

export interface AdaptiveRequest {
  cacheHit: boolean;
  cacheIdentity: string;
  canonicalArtist: string;
  canonicalArtistId: string;
  cohortStratum: string;
  expectedDecisionContribution: string;
  historicalAnchor: string;
  normalizedParameters: Record<string, string>;
  operationType: "artist_album_lookup" | "targeted_collection_search";
  reason: string;
  requestOrder: number;
  strategy: "album_first" | "targeted_search";
}

export interface AdaptiveManifest {
  artists: Array<{
    canonicalArtist: string;
    canonicalArtistId: string;
    stratum: string;
  }>;
  canonicalContentSha256: string;
  configuration: {
    liveRequestCeilingMs: 900_000;
    maximumArtists: 50;
    maximumNewRequests: 150;
    minimumRequestStartIntervalMs: 3_200;
    oneRequestAtATime: true;
  };
  generatedFrom: {
    censusCanonicalContentSha256: string;
    historicalEvidenceCanonicalContentSha256: string;
  };
  kind: "itunes_adaptive_identity_dry_run";
  requests: AdaptiveRequest[];
  summary: {
    artistCount: number;
    cacheHits: number;
    newRequests: number;
    requestCount: number;
    runtimeFloorMs: number;
    strategyCounts: Record<string, number>;
  };
  version: 1;
}

export interface AdaptivePlan {
  albumFirst: {
    albumOnlyResolvedControls: number;
    ambiguousControlArtists: number;
    candidateRequestExtrapolationRatio: number;
    estimatedAlbumRequests: number;
    estimatedReductionFromBaseline: number;
    estimatedRuntimeMs: number;
    estimatedShardCount: number;
    estimatedSongRequests: number;
    estimatedTotalRequests: number;
    evidenceConfirmedControls: number;
    knownMappingsChangedIncorrectly: number;
    remainingAmbiguousControls: number;
    songFallbackControls: number;
  };
  ambiguousEvidence: {
    completeAlbumOrEpEvidence: number;
    onlyGenericTitles: number;
    onlyRemixOrFeatureEvidence: number;
    resultLimited: number;
    resultLimitedAndLackingStrongEvidence: number;
    twoOrMoreUsableAnchors: number;
    zeroUsableAnchors: number;
    oneUsableAnchor: number;
  };
  baseline: {
    albumCacheHits: number;
    newAlbumRequests: number;
    newSongRequests: number;
    newTotalRequests: number;
    runtimeFloorMs: number;
    shardCount: number;
    songCacheHits: number;
  };
  cohort: {
    artistCount: number;
    cacheHits: number;
    newRequests: number;
    requestCount: number;
    runtimeFloorMs: number;
    strategyCounts: Record<string, number>;
  };
  evidence: {
    artistCount: number;
    artistsWithUsableHistoricalEvidence: number;
    artistsWithoutUsableHistoricalEvidence: number;
    releaseCount: number;
    trackCount: number;
  };
  hybrid: {
    artistsEligibleForTargetedSearch: number;
    artistsLackingUsableAnchors: number;
    artistsLikelyToRequireBruteForceFallback: number;
    artistsRequiringNoNewRequest: number;
    bestCase: StrategyBound;
    expected: StrategyBound & {
      assumptions: string[];
    };
    maximumRequestsPerArtist: number;
    worstCase: StrategyBound;
  };
  inventory: IdentityEvidenceInventoryRow[];
  manifest: AdaptiveManifest;
  recommendation:
    | "album_first_adaptive_lookup"
    | "brute_force_album_and_song"
    | "historical_title_targeted_search"
    | "hybrid_targeted_search_plus_adaptive_lookup"
    | "no_further_itunes_identity_work";
}

interface StrategyBound {
  reductionFromBaseline: number;
  requestCount: number;
  runtimeFloorMs: number;
  shardCount: number;
}

interface PilotSnapshot {
  artists: Array<{
    canonicalArtistId: string;
    canonicalName: string;
  }>;
  snapshotHash: string;
}

interface PilotEvaluation {
  baseline: {
    corrected: {
      mapping: {
        ambiguous: number;
        evidenceConfirmed: number;
        exactConfirmed: number;
      };
    };
  };
  identityProvenance: Array<{
    canonicalArtist: string;
    canonicalArtistId: string;
    competingAppleArtistIds: string[];
    evidenceItems: Array<{
      evidenceKind: "release" | "track";
      spotifyId: string;
      spotifyTitle: string;
    }>;
    selectedAppleArtistId: string;
  }>;
}

export async function readAdaptivePlanningInputs(input: {
  censusPath: string;
  historicalEvidencePath: string;
  pilotEvaluationPath: string;
  pilotSnapshotPath: string;
}): Promise<{
  census: CensusResultArtifact;
  historical: HistoricalIdentityEvidenceSnapshot;
  pilotEvaluation: PilotEvaluation;
  pilotSnapshot: PilotSnapshot;
}> {
  const censusBytes = await readFile(resolve(input.censusPath));
  if (sha256(censusBytes) !== adaptiveCensusFileSha256) {
    throw new Error("The completed census file hash differs from the frozen value.");
  }
  const census = JSON.parse(censusBytes.toString("utf8")) as CensusResultArtifact;
  if (
    census.kind !== "itunes_full_watchlist_search_census" ||
    census.completenessState !== "complete" ||
    census.canonicalContentSha256 !== adaptiveCensusCanonicalSha256 ||
    census.artists.length !== 593
  ) {
    throw new Error("The completed census artifact is incomplete or differs.");
  }
  const historical = await readHistoricalIdentityEvidence(input.historicalEvidencePath);
  const pilotSnapshot = JSON.parse(
    await readFile(resolve(input.pilotSnapshotPath), "utf8"),
  ) as PilotSnapshot;
  if (
    pilotSnapshot.snapshotHash !== adaptivePilotSnapshotSha256 ||
    pilotSnapshot.artists.length !== 50
  ) {
    throw new Error("The original 50-artist pilot snapshot differs.");
  }
  const pilotEvaluation = JSON.parse(
    await readFile(resolve(input.pilotEvaluationPath), "utf8"),
  ) as PilotEvaluation;
  if (
    pilotEvaluation.baseline.corrected.mapping.exactConfirmed !== 26 ||
    pilotEvaluation.baseline.corrected.mapping.evidenceConfirmed !== 13 ||
    pilotEvaluation.baseline.corrected.mapping.ambiguous !== 11 ||
    pilotEvaluation.identityProvenance.length !== 13
  ) {
    throw new Error("The corrected offline pilot evaluation differs.");
  }
  return { census, historical, pilotEvaluation, pilotSnapshot };
}

export function buildAdaptivePlan(input: {
  census: CensusResultArtifact;
  historical: HistoricalIdentityEvidenceSnapshot;
  legacyCacheIdentities: string[];
  pilotEvaluation: PilotEvaluation;
  pilotSnapshot: PilotSnapshot;
}): AdaptivePlan {
  const historicalById = new Map(
    input.historical.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  const inventory = input.census.artists
    .map((artist) => {
      const historical = historicalById.get(artist.canonicalArtistId);
      if (!historical)
        throw new Error(`Historical evidence is missing ${artist.canonicalArtistId}.`);
      return inventoryRow(artist, scoreHistoricalIdentityArtist(historical));
    })
    .sort(
      (left, right) =>
        compareText(normalizeText(left.canonicalName), normalizeText(right.canonicalName)) ||
        compareText(left.canonicalArtistId, right.canonicalArtistId),
    );
  const ambiguous = inventory.filter(
    (row) => row.searchStageMappingState === "competing_exact_or_alias",
  );
  if (ambiguous.length !== 285) throw new Error("Expected 285 ambiguous census artists.");

  const ambiguousEvidence = {
    completeAlbumOrEpEvidence: ambiguous.filter(
      (row) => row.hasAlbumOrEpEvidence && row.completeReleaseCount > 0,
    ).length,
    onlyGenericTitles: ambiguous.filter(
      (row) =>
        row.usableAnchorCount > 0 &&
        !row.exactHistoricalReleaseTitles &&
        !row.distinctiveTrackTitles,
    ).length,
    onlyRemixOrFeatureEvidence: ambiguous.filter(
      (row) => row.remixOnlyEvidence || row.featureOnlyEvidence,
    ).length,
    resultLimited: ambiguous.filter((row) => row.resultLimitReached).length,
    resultLimitedAndLackingStrongEvidence: ambiguous.filter(
      (row) => row.resultLimitReached && row.anchorQuality !== "strong",
    ).length,
    twoOrMoreUsableAnchors: ambiguous.filter((row) => row.usableAnchorCount >= 2).length,
    zeroUsableAnchors: ambiguous.filter((row) => row.usableAnchorCount === 0).length,
    oneUsableAnchor: ambiguous.filter((row) => row.usableAnchorCount === 1).length,
  };

  const baseline = {
    albumCacheHits: input.census.analysis.futureCatalogEvidence.albumCacheCandidateIds,
    newAlbumRequests: input.census.analysis.futureCatalogEvidence.newAlbumRequests,
    newSongRequests: input.census.analysis.futureCatalogEvidence.newSongRequests,
    newTotalRequests: input.census.analysis.futureCatalogEvidence.newTotalRequests,
    runtimeFloorMs: input.census.analysis.futureCatalogEvidence.projectedRuntimeMs,
    shardCount: input.census.analysis.futureCatalogEvidence.shardCount,
    songCacheHits: input.census.analysis.futureCatalogEvidence.songCacheCandidateIds,
  };
  const albumFirst = simulateAlbumFirst(input.census, input.pilotSnapshot, input.pilotEvaluation);
  const manifest = buildAdaptiveManifest({
    census: input.census,
    historicalCanonicalContentSha256: input.historical.canonicalContentSha256,
    inventory,
    legacyCacheIdentities: new Set(input.legacyCacheIdentities),
    pilotEvaluation: input.pilotEvaluation,
    pilotSnapshot: input.pilotSnapshot,
  });
  const hybrid = hybridBounds({
    ambiguousRows: ambiguous,
    baselineRequests: baseline.newTotalRequests,
    census: input.census,
    inventory,
  });
  return {
    albumFirst,
    ambiguousEvidence,
    baseline,
    cohort: manifest.summary,
    evidence: {
      artistCount: input.historical.summary.artistCount,
      artistsWithUsableHistoricalEvidence:
        input.historical.summary.artistsWithUsableHistoricalEvidence,
      artistsWithoutUsableHistoricalEvidence:
        input.historical.summary.artistsWithoutUsableHistoricalEvidence,
      releaseCount: input.historical.summary.releaseCount,
      trackCount: input.historical.summary.trackCount,
    },
    hybrid,
    inventory,
    manifest,
    recommendation: "hybrid_targeted_search_plus_adaptive_lookup",
  };
}

export function scoreHistoricalIdentityArtist(
  artist: HistoricalIdentityArtist,
): ArtistHistoricalScore {
  const duplicates = duplicateReleaseIds(artist.releases);
  const anchors = artist.releases
    .map((release) => scoreRelease(artist, release, duplicates.has(release.spotifyReleaseId)))
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.releaseDate, right.releaseDate) ||
        compareText(left.normalizedTitle, right.normalizedTitle) ||
        compareText(left.spotifyReleaseId, right.spotifyReleaseId),
    )
    .map((anchor, index) => ({ ...anchor, selectionOrder: index + 1 }));
  const usable = anchors.filter((anchor) => anchor.quality !== "unusable");
  const usableReleases = artist.releases.filter((release) =>
    usable.some((anchor) => anchor.spotifyReleaseId === release.spotifyReleaseId),
  );
  const top = usable[0]?.score ?? 0;
  const second = usable[1]?.score ?? 0;
  const anchorScore = top + Math.min(second, 4);
  const anchorQuality: AnchorQuality =
    usable.some((anchor) => anchor.quality === "strong") || (top >= 7 && second >= 7)
      ? "strong"
      : usable.some((anchor) => anchor.quality === "moderate")
        ? "moderate"
        : usable.length > 0
          ? "weak"
          : "unusable";
  const dates = usableReleases.map((release) => release.releaseDate).sort(compareText);
  const exactPrimaryCount = usableReleases.filter((release) =>
    release.primaryCreditedArtistIds.includes(artist.spotifyArtistId),
  ).length;
  return {
    anchorQuality,
    anchorScore,
    anchors,
    completeReleaseCount: artist.releases.filter(
      (release) =>
        release.usableForStrongIdentity && release.retrievalCompletenessState === "completed",
    ).length,
    distinctiveTrackTitles: usableReleases.some((release) => distinctiveTrackCount(release) >= 2),
    earliestUsableEvidenceDate: dates[0] ?? "",
    exactHistoricalReleaseTitles: usableReleases.some((release) =>
      isDistinctiveTitle(release.normalizedTitle),
    ),
    featureOnlyEvidence:
      artist.releases.length > 0 &&
      exactPrimaryCount === 0 &&
      artist.releases.some((release) =>
        release.appearanceOrFeatureArtistIds.includes(artist.spotifyArtistId),
      ),
    hasAlbumOrEpEvidence: usableReleases.some((release) =>
      ["album", "ep"].includes(release.releaseType),
    ),
    historicalReleaseCount: artist.releases.length,
    historicalTrackCount: artist.releases.reduce(
      (total, release) => total + release.tracks.length,
      0,
    ),
    latestUsableEvidenceDate: dates.at(-1) ?? "",
    noUsableHistoricalEvidence: usable.length === 0,
    remixOnlyEvidence:
      usableReleases.length > 0 &&
      usableReleases.every((release) =>
        release.versionMarkers.some((marker) => weakVersionMarkers.has(marker)),
      ),
    singleOnlyEvidence:
      usableReleases.length > 0 &&
      usableReleases.every((release) => release.releaseType === "single"),
    usableAnchorCount: usable.length,
  };
}

export function simulateAlbumFirst(
  census: CensusResultArtifact,
  pilotSnapshot: PilotSnapshot,
  evaluation: PilotEvaluation,
): AdaptivePlan["albumFirst"] {
  const pilotIds = new Set(pilotSnapshot.artists.map((artist) => artist.canonicalArtistId));
  const originalAmbiguous = census.artists.filter(
    (artist) =>
      pilotIds.has(artist.canonicalArtistId) &&
      artist.searchStageMappingState === "competing_exact_or_alias",
  );
  const evidenceControls = new Map(
    evaluation.identityProvenance.map((row) => [row.canonicalArtistId, row]),
  );
  const albumOnly = evaluation.identityProvenance.filter((row) => {
    const independentReleaseIds = new Set(
      row.evidenceItems
        .filter((item) => item.evidenceKind === "release")
        .map((item) => item.spotifyId),
    );
    return independentReleaseIds.size >= 2;
  });
  const songFallbackArtists = originalAmbiguous.filter(
    (artist) =>
      !albumOnly.some((control) => control.canonicalArtistId === artist.canonicalArtistId),
  );
  const ambiguousCandidates = sum(
    originalAmbiguous.map((artist) => artist.plausibleCandidateIds.length),
  );
  const fallbackCandidates = sum(
    songFallbackArtists.map((artist) => artist.plausibleCandidateIds.length),
  );
  const ratio = fallbackCandidates / ambiguousCandidates;
  const estimatedAlbumRequests = census.analysis.futureCatalogEvidence.newAlbumRequests;
  const estimatedSongRequests = Math.round(
    census.analysis.futureCatalogEvidence.newSongRequests * ratio,
  );
  const estimatedTotalRequests = estimatedAlbumRequests + estimatedSongRequests;
  return {
    albumOnlyResolvedControls: albumOnly.length,
    ambiguousControlArtists: originalAmbiguous.length,
    candidateRequestExtrapolationRatio: ratio,
    estimatedAlbumRequests,
    estimatedReductionFromBaseline:
      census.analysis.futureCatalogEvidence.newTotalRequests - estimatedTotalRequests,
    estimatedRuntimeMs: estimatedTotalRequests * adaptivePacingMs,
    estimatedShardCount: Math.ceil(estimatedTotalRequests / adaptiveRequestLimit),
    estimatedSongRequests,
    estimatedTotalRequests,
    evidenceConfirmedControls: evidenceControls.size,
    knownMappingsChangedIncorrectly: 0,
    remainingAmbiguousControls: songFallbackArtists.length,
    songFallbackControls: songFallbackArtists.length,
  };
}

export function adaptiveCacheIdentity(input: {
  operationType: string;
  parameters: Record<string, string>;
  providerBehaviorVersion: string;
  responseNormalizationVersion: string;
  storefront: string;
}): string {
  const parameters = Object.fromEntries(
    Object.entries(input.parameters)
      .map(([key, value]) => [key.normalize("NFC"), value.trim().normalize("NFC")] as const)
      .sort(([left], [right]) => compareText(left, right)),
  );
  const components = {
    operation: input.operationType,
    parameters,
    provider: "itunes",
    providerBehaviorVersion: input.providerBehaviorVersion,
    responseNormalizationVersion: input.responseNormalizationVersion,
    storefront: input.storefront.toUpperCase(),
  };
  return `itunes-cache:v2:${sha256(Buffer.from(stableJson(components), "utf8"))}:${encodeURIComponent(stableJson(components))}`;
}

export function legacyAlbumLookupIdentity(artistId: string, storefront = "US"): string {
  if (!/^\d+$/.test(artistId)) throw new Error("Apple artist ID must be numeric.");
  const parameters = new URLSearchParams({
    country: storefront.toUpperCase(),
    entity: "album",
    explicit: "Yes",
    id: artistId,
    limit: "200",
  });
  parameters.sort();
  return `/lookup?${parameters.toString()}`;
}

export function searchResultTruncationRisk(
  declaredResultCount: number,
  configuredLimit = 10,
): boolean {
  return declaredResultCount >= configuredLimit;
}

export function identityEvidenceCsv(rows: IdentityEvidenceInventoryRow[]): string {
  const headers = [
    "canonical_artist_id",
    "canonical_name",
    "search_stage_mapping_state",
    "plausible_apple_candidate_count",
    "result_limit_reached",
    "historical_release_count",
    "complete_historical_release_count",
    "historical_track_count",
    "usable_identity_anchor_count",
    "anchor_score",
    "anchor_quality",
    "earliest_usable_evidence_date",
    "latest_usable_evidence_date",
    "exact_historical_release_titles",
    "distinctive_track_titles",
    "album_or_ep_evidence",
    "single_only_evidence",
    "remix_only_evidence",
    "feature_only_evidence",
    "no_usable_historical_evidence",
  ];
  const lines = rows.map((row) =>
    [
      row.canonicalArtistId,
      row.canonicalName,
      row.searchStageMappingState,
      row.plausibleAppleCandidateCount,
      row.resultLimitReached,
      row.historicalReleaseCount,
      row.completeReleaseCount,
      row.historicalTrackCount,
      row.usableAnchorCount,
      row.anchorScore,
      row.anchorQuality,
      row.earliestUsableEvidenceDate,
      row.latestUsableEvidenceDate,
      row.exactHistoricalReleaseTitles,
      row.distinctiveTrackTitles,
      row.hasAlbumOrEpEvidence,
      row.singleOnlyEvidence,
      row.remixOnlyEvidence,
      row.featureOnlyEvidence,
      row.noUsableHistoricalEvidence,
    ]
      .map(csv)
      .join(","),
  );
  return `${headers.join(",")}\n${lines.join("\n")}\n`;
}

export async function writeAdaptiveArtifacts(input: {
  inventoryPath: string;
  manifestPath: string;
  plan: AdaptivePlan;
}): Promise<{
  inventoryFileSha256: string;
  manifestCanonicalContentSha256: string;
  manifestFileSha256: string;
  manifestPath: string;
}> {
  const inventory = identityEvidenceCsv(input.plan.inventory);
  if (inventory !== identityEvidenceCsv(input.plan.inventory)) {
    throw new Error("The identity-evidence CSV was not deterministic.");
  }
  await writeFile(resolve(input.inventoryPath), inventory, "utf8");
  const manifest = serializeAdaptiveManifest(input.plan.manifest);
  if (manifest !== serializeAdaptiveManifest(input.plan.manifest)) {
    throw new Error("The adaptive dry-run manifest was not deterministic.");
  }
  const manifestPath = resolve(input.manifestPath);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, manifest, { encoding: "utf8", flag: "wx" });
  return {
    inventoryFileSha256: sha256(Buffer.from(inventory, "utf8")),
    manifestCanonicalContentSha256: input.plan.manifest.canonicalContentSha256,
    manifestFileSha256: sha256(Buffer.from(manifest, "utf8")),
    manifestPath,
  };
}

function scoreRelease(
  artist: HistoricalIdentityArtist,
  release: HistoricalIdentityRelease,
  duplicate: boolean,
): HistoricalAnchorScore {
  const includedEvidence: string[] = [];
  const excludedEvidence: string[] = [];
  const exclusionReasons = [...release.exclusionReasons];
  const primaryExact = release.primaryCreditedArtistIds.includes(artist.spotifyArtistId);
  const featureOnly =
    !primaryExact && release.appearanceOrFeatureArtistIds.includes(artist.spotifyArtistId);
  const distinctiveRelease = isDistinctiveTitle(release.normalizedTitle);
  const tracks = distinctiveTrackCount(release);
  const weakVersionOnly =
    release.versionMarkers.length > 0 &&
    release.versionMarkers.every((marker) => weakVersionMarkers.has(marker));
  let score = 0;
  if (release.usableForStrongIdentity) {
    score += 3;
    includedEvidence.push("complete_retrieval");
  } else {
    excludedEvidence.push("incomplete_or_cutoff_unsafe_release");
  }
  if (primaryExact) {
    score += 4;
    includedEvidence.push("exact_canonical_primary_credit");
  } else {
    exclusionReasons.push(featureOnly ? "feature_only_credit" : "conflicting_primary_credit");
    excludedEvidence.push("canonical_primary_credit_not_proven");
  }
  if (["album", "ep"].includes(release.releaseType)) {
    score += 3;
    includedEvidence.push("album_or_ep");
  } else if (release.releaseType === "single") {
    score += 1;
    includedEvidence.push("single");
  } else if (release.releaseType === "compilation") {
    score -= 3;
    exclusionReasons.push("compilation_appearance");
  }
  if (distinctiveRelease) {
    score += 2;
    includedEvidence.push("distinctive_release_title");
  } else {
    score -= 2;
    exclusionReasons.push("generic_release_title");
  }
  if (tracks >= 2) {
    score += 3;
    includedEvidence.push("multiple_distinctive_track_titles");
  } else if (tracks === 1) {
    score += 1;
    includedEvidence.push("one_distinctive_track_title");
  } else {
    excludedEvidence.push("no_distinctive_track_title");
  }
  if (release.versionMarkers.length > 0) {
    score += weakVersionOnly ? 0 : 1;
    includedEvidence.push("version_markers_preserved");
  }
  if (new Date(release.sourceObservationTimestamp) < new Date(adaptiveHistoricalEvidenceCutoff)) {
    score += 1;
    includedEvidence.push("observed_before_census_cutoff");
  }
  if (weakVersionOnly) {
    score -= 2;
    exclusionReasons.push("remix_or_version_only_evidence");
  }
  if (duplicate) {
    score = 0;
    exclusionReasons.push("duplicate_release_edition");
    excludedEvidence.push("duplicate_release_edition");
  }
  const independentlyEligible =
    release.usableForStrongIdentity && primaryExact && !featureOnly && !duplicate;
  const quality: AnchorQuality = !independentlyEligible
    ? "unusable"
    : score >= 10 &&
        distinctiveRelease &&
        (["album", "ep"].includes(release.releaseType) || tracks >= 2)
      ? "strong"
      : score >= 7
        ? "moderate"
        : score > 0
          ? "weak"
          : "unusable";
  return {
    excludedEvidence: [...new Set(excludedEvidence)].sort(compareText),
    exclusionReasons: [...new Set(exclusionReasons)].sort(compareText),
    includedEvidence: [...new Set(includedEvidence)].sort(compareText),
    normalizedTitle: release.normalizedTitle,
    originalTitle: release.originalTitle,
    quality,
    releaseDate: release.releaseDate,
    releaseType: release.releaseType,
    score: Math.max(0, score),
    selectionOrder: 0,
    spotifyReleaseId: release.spotifyReleaseId,
    versionMarkers: [...release.versionMarkers],
  };
}

function duplicateReleaseIds(releases: HistoricalIdentityRelease[]): Set<string> {
  const groups = new Map<string, HistoricalIdentityRelease[]>();
  for (const release of releases) {
    const key = `${release.normalizedTitle}|${release.releaseDate}|${release.releaseType}`;
    groups.set(key, [...(groups.get(key) ?? []), release]);
  }
  const duplicates = new Set<string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      compareText(left.spotifyReleaseId, right.spotifyReleaseId),
    );
    for (const release of ordered.slice(1)) duplicates.add(release.spotifyReleaseId);
  }
  return duplicates;
}

function distinctiveTrackCount(release: HistoricalIdentityRelease): number {
  return new Set(
    release.tracks
      .filter((track) => track.usableForStrongIdentity && isDistinctiveTitle(track.normalizedTitle))
      .map((track) => track.normalizedTitle),
  ).size;
}

function isDistinctiveTitle(value: string): boolean {
  const normalized = normalizeText(value).trim();
  if (!normalized || genericTitles.has(normalized)) return false;
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length === 1 && (normalized.length < 6 || weakVersionMarkers.has(normalized))) {
    return false;
  }
  return !terms.every((term) => genericTitles.has(term) || weakVersionMarkers.has(term));
}

function inventoryRow(
  artist: CensusArtifactArtist,
  historical: ArtistHistoricalScore,
): IdentityEvidenceInventoryRow {
  return {
    ...historical,
    canonicalArtistId: artist.canonicalArtistId,
    canonicalName: artist.displayName,
    plausibleAppleCandidateCount: artist.plausibleCandidateIds.length,
    resultLimitReached: searchResultTruncationRisk(artist.declaredResultCount),
    searchStageMappingState: artist.searchStageMappingState ?? "not_processed",
  };
}

function hybridBounds(input: {
  ambiguousRows: IdentityEvidenceInventoryRow[];
  baselineRequests: number;
  census: CensusResultArtifact;
  inventory: IdentityEvidenceInventoryRow[];
}): AdaptivePlan["hybrid"] {
  const unresolvedRows = input.inventory.filter(
    (row) =>
      !["unique_exact_canonical", "unique_alias_supported"].includes(row.searchStageMappingState),
  );
  const eligible = unresolvedRows.filter((row) =>
    ["strong", "moderate"].includes(row.anchorQuality),
  );
  const lacking = unresolvedRows.filter((row) => row.usableAnchorCount === 0);
  const weak = unresolvedRows.filter((row) => row.usableAnchorCount > 0 && !eligible.includes(row));
  const censusById = new Map(
    input.census.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  const candidateCount = (rows: IdentityEvidenceInventoryRow[]) =>
    sum(
      rows.map((row) => censusById.get(row.canonicalArtistId)?.plausibleCandidateIds.length ?? 0),
    );
  const unresolvedCandidates = candidateCount(unresolvedRows);
  const bestRequests = eligible.length * 2 + (lacking.length + weak.length);
  const assumedTargetedResolution = Math.round(
    eligible.filter((row) => row.anchorQuality === "strong").length * 0.6 +
      eligible.filter((row) => row.anchorQuality === "moderate").length * 0.3,
  );
  const targetedUnresolvedCount = eligible.length - assumedTargetedResolution;
  const averageEligibleCandidates =
    eligible.length > 0 ? candidateCount(eligible) / eligible.length : 0;
  const fallbackCandidateRequests = Math.round(
    targetedUnresolvedCount * averageEligibleCandidates + candidateCount([...lacking, ...weak]),
  );
  const expectedRequests =
    eligible.length +
    assumedTargetedResolution +
    fallbackCandidateRequests +
    Math.round(fallbackCandidateRequests * (75 / 119));
  const worstRequests = eligible.length * 2 + unresolvedCandidates * 2;
  const bound = (requests: number): StrategyBound => ({
    reductionFromBaseline: input.baselineRequests - requests,
    requestCount: requests,
    runtimeFloorMs: requests * adaptivePacingMs,
    shardCount: Math.ceil(requests / adaptiveRequestLimit),
  });
  return {
    artistsEligibleForTargetedSearch: eligible.length,
    artistsLackingUsableAnchors: lacking.length,
    artistsLikelyToRequireBruteForceFallback: lacking.length + weak.length,
    artistsRequiringNoNewRequest: input.inventory.filter((row) =>
      ["unique_exact_canonical", "unique_alias_supported"].includes(row.searchStageMappingState),
    ).length,
    bestCase: bound(bestRequests),
    expected: {
      ...bound(expectedRequests),
      assumptions: [
        "60% of strong-anchor artists are uniquely corroborated by targeted search.",
        "30% of moderate-anchor artists are uniquely corroborated by targeted search.",
        "A targeted success receives one album confirmation lookup.",
        "Fallback song demand uses the measured 75/119 original-pilot candidate ratio.",
        "Targeted-search success rates are planning assumptions, not live measurements.",
      ],
    },
    maximumRequestsPerArtist: 22,
    worstCase: bound(worstRequests),
  };
}

function buildAdaptiveManifest(input: {
  census: CensusResultArtifact;
  historicalCanonicalContentSha256: string;
  inventory: IdentityEvidenceInventoryRow[];
  legacyCacheIdentities: Set<string>;
  pilotEvaluation: PilotEvaluation;
  pilotSnapshot: PilotSnapshot;
}): AdaptiveManifest {
  const censusById = new Map(
    input.census.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  const inventoryById = new Map(input.inventory.map((row) => [row.canonicalArtistId, row]));
  const controls = new Map(
    input.pilotEvaluation.identityProvenance.map((row) => [row.canonicalArtistId, row]),
  );
  const pilotIds = new Set(input.pilotSnapshot.artists.map((artist) => artist.canonicalArtistId));
  const selected = new Map<string, string>();
  for (const control of [...controls.values()].sort((left, right) =>
    compareText(left.canonicalArtistId, right.canonicalArtistId),
  )) {
    selected.set(control.canonicalArtistId, "original_evidence_confirmed_control");
  }
  for (const artist of input.census.artists
    .filter(
      (artist) =>
        pilotIds.has(artist.canonicalArtistId) &&
        artist.searchStageMappingState === "competing_exact_or_alias" &&
        !controls.has(artist.canonicalArtistId),
    )
    .sort((left, right) => compareText(left.canonicalArtistId, right.canonicalArtistId))) {
    selected.set(artist.canonicalArtistId, "original_ambiguous_control");
  }
  const remaining = input.inventory
    .filter(
      (row) =>
        row.searchStageMappingState === "competing_exact_or_alias" &&
        !selected.has(row.canonicalArtistId),
    )
    .sort((left, right) => compareText(left.canonicalArtistId, right.canonicalArtistId));
  const strata: Array<[string, (row: IdentityEvidenceInventoryRow) => boolean]> = [
    ["two_or_three_candidates", (row) => [2, 3].includes(row.plausibleAppleCandidateCount)],
    [
      "four_to_nine_candidates",
      (row) => row.plausibleAppleCandidateCount >= 4 && row.plausibleAppleCandidateCount <= 9,
    ],
    ["ten_result_limit", (row) => row.resultLimitReached],
    ["strong_album_anchor", (row) => row.anchorQuality === "strong" && row.hasAlbumOrEpEvidence],
    ["single_only_anchor", (row) => row.singleOnlyEvidence],
    ["remix_or_feature_heavy", (row) => row.remixOnlyEvidence || row.featureOnlyEvidence],
    ["no_usable_anchor", (row) => row.noUsableHistoricalEvidence],
  ];
  while (selected.size < adaptiveArtistLimit) {
    let added = false;
    for (const [stratum, predicate] of strata) {
      const row = remaining.find(
        (candidate) => !selected.has(candidate.canonicalArtistId) && predicate(candidate),
      );
      if (row) {
        selected.set(row.canonicalArtistId, stratum);
        added = true;
        if (selected.size === adaptiveArtistLimit) break;
      }
    }
    if (!added) break;
  }
  const selectedArtists = [...selected.entries()].map(([canonicalArtistId, stratum]) => {
    const census = censusById.get(canonicalArtistId);
    const inventory = inventoryById.get(canonicalArtistId);
    if (!census || !inventory)
      throw new Error(`Selected cohort artist missing: ${canonicalArtistId}`);
    return { census, inventory, stratum };
  });
  const requests: AdaptiveRequest[] = [];
  for (const item of selectedArtists) {
    const control = controls.get(item.census.canonicalArtistId);
    const anchor = item.inventory.anchors.find((candidate) =>
      ["strong", "moderate"].includes(candidate.quality),
    );
    if (anchor) {
      const parameters = {
        country: "US",
        entity: "album",
        explicit: "Yes",
        lang: "en_us",
        limit: "25",
        media: "music",
        term: `${item.census.displayName} ${anchor.originalTitle}`.normalize("NFC"),
      };
      requests.push({
        cacheHit: false,
        cacheIdentity: adaptiveCacheIdentity({
          operationType: "targeted_collection_search",
          parameters,
          providerBehaviorVersion: "targeted-search-v1",
          responseNormalizationVersion: "itunes-normalized-v1",
          storefront: "US",
        }),
        canonicalArtist: item.census.displayName,
        canonicalArtistId: item.census.canonicalArtistId,
        cohortStratum: item.stratum,
        expectedDecisionContribution:
          "Test whether a distinctive historical title identifies one corroborated Apple artist ID.",
        historicalAnchor: anchor.originalTitle,
        normalizedParameters: parameters,
        operationType: "targeted_collection_search",
        reason: "Highest-ranked strong or moderate historical release anchor.",
        requestOrder: 0,
        strategy: "targeted_search",
      });
    }
    const candidateIds = control
      ? [control.selectedAppleArtistId]
      : item.census.plausibleCandidateIds.slice(0, anchor ? 1 : 2);
    for (const candidateId of candidateIds) {
      const identity = legacyAlbumLookupIdentity(candidateId);
      requests.push({
        cacheHit: input.legacyCacheIdentities.has(identity),
        cacheIdentity: identity,
        canonicalArtist: item.census.displayName,
        canonicalArtistId: item.census.canonicalArtistId,
        cohortStratum: item.stratum,
        expectedDecisionContribution: control
          ? "Compare album-first evidence with the labeled selected Apple artist ID."
          : "Measure whether album evidence separates the highest-ranked plausible candidates.",
        historicalAnchor: anchor?.originalTitle ?? "",
        normalizedParameters: {
          country: "US",
          entity: "album",
          explicit: "Yes",
          id: candidateId,
          limit: "200",
        },
        operationType: "artist_album_lookup",
        reason: control
          ? "Labeled control comparison."
          : anchor
            ? "Minimum album confirmation after targeted search."
            : "Album-first fallback for an artist without a usable targeted anchor.",
        requestOrder: 0,
        strategy: "album_first",
      });
    }
  }
  const uniqueRequests = [
    ...new Map(requests.map((request) => [request.cacheIdentity, request])).values(),
  ];
  const ordered = uniqueRequests
    .sort(
      (left, right) =>
        compareText(left.canonicalArtistId, right.canonicalArtistId) ||
        compareText(left.strategy, right.strategy) ||
        compareText(left.cacheIdentity, right.cacheIdentity),
    )
    .map((request, index) => ({ ...request, requestOrder: index + 1 }));
  const newRequests = ordered.filter((request) => !request.cacheHit).length;
  const content = {
    artists: selectedArtists
      .map((item) => ({
        canonicalArtist: item.census.displayName,
        canonicalArtistId: item.census.canonicalArtistId,
        stratum: item.stratum,
      }))
      .sort((left, right) => compareText(left.canonicalArtistId, right.canonicalArtistId)),
    configuration: {
      liveRequestCeilingMs: 900_000 as const,
      maximumArtists: 50 as const,
      maximumNewRequests: 150 as const,
      minimumRequestStartIntervalMs: 3_200 as const,
      oneRequestAtATime: true as const,
    },
    generatedFrom: {
      censusCanonicalContentSha256: adaptiveCensusCanonicalSha256,
      historicalEvidenceCanonicalContentSha256: input.historicalCanonicalContentSha256,
    },
    kind: "itunes_adaptive_identity_dry_run" as const,
    requests: ordered,
    summary: {
      artistCount: selectedArtists.length,
      cacheHits: ordered.length - newRequests,
      newRequests,
      requestCount: ordered.length,
      runtimeFloorMs: newRequests * adaptivePacingMs,
      strategyCounts: countBy(ordered.map((request) => request.strategy)),
    },
    version: 1 as const,
  };
  const manifest = {
    ...content,
    canonicalContentSha256: adaptiveManifestCanonicalContentSha256(content),
  };
  validateAdaptiveManifest(manifest);
  return manifest;
}

export function serializeAdaptiveManifest(manifest: AdaptiveManifest): string {
  validateAdaptiveManifest(manifest);
  const { canonicalContentSha256, ...content } = manifest;
  if (adaptiveManifestCanonicalContentSha256(content) !== canonicalContentSha256) {
    throw new Error("The adaptive manifest canonical hash differs.");
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function adaptiveManifestCanonicalContentSha256(
  content: Omit<AdaptiveManifest, "canonicalContentSha256">,
): string {
  return sha256(Buffer.from(stableJson(content), "utf8"));
}

export function validateAdaptiveManifest(manifest: AdaptiveManifest): void {
  if (
    manifest.version !== 1 ||
    manifest.kind !== "itunes_adaptive_identity_dry_run" ||
    manifest.artists.length > adaptiveArtistLimit ||
    manifest.summary.artistCount !== manifest.artists.length ||
    manifest.summary.requestCount !== manifest.requests.length ||
    manifest.summary.newRequests > adaptiveRequestLimit ||
    manifest.summary.runtimeFloorMs !== manifest.summary.newRequests * adaptivePacingMs ||
    manifest.summary.runtimeFloorMs > manifest.configuration.liveRequestCeilingMs ||
    new Set(manifest.requests.map((request) => request.cacheIdentity)).size !==
      manifest.requests.length ||
    manifest.requests.some(
      (request, index) =>
        request.requestOrder !== index + 1 ||
        !["artist_album_lookup", "targeted_collection_search"].includes(request.operationType),
    )
  ) {
    throw new Error("The adaptive dry-run manifest violates its deterministic bounds.");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function csv(value: boolean | number | string): string {
  const text = String(value).normalize("NFC");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function countBy(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort(compareText)
      .map((value) => [value, values.filter((candidate) => candidate === value).length]),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
