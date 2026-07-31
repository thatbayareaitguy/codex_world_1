import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  normalizeArtistIdentity,
  normalizeText,
  resolveItunesArtistFromCatalogEvidence,
  type ItunesIdentityCandidateCatalog,
  type ItunesMappingDecision,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import type { ItunesCollection, ItunesNormalizedResponse } from "@radar/providers";
import {
  adaptiveCacheIdentity,
  adaptiveManifestCanonicalContentSha256,
  legacyAlbumLookupIdentity,
  validateAdaptiveManifest,
  type AdaptiveManifest,
  type AdaptiveRequest,
} from "./itunes-adaptive-identity-planner";
import {
  readHistoricalIdentityEvidence,
  type HistoricalIdentityArtist,
  type HistoricalIdentityEvidenceSnapshot,
} from "./itunes-historical-identity-evidence";

export const experimentRunKind = "adaptive_identity_experiment_v1";
export const experimentExpectedBranch = "codex/itunes-discovery";
export const experimentNetworkBudget = 79;
export const experimentOperationCount = 98;
export const experimentArtistCount = 50;
export const experimentCanaryLimit = 15;
export const experimentManifestFileSha256 =
  "b24b51bfbeba03c75e74ed2a59d5d7c7bff0dcadce5e12147af9c2c6413211e0";
export const experimentManifestCanonicalSha256 =
  "271012f7cb5b8c2d95e6a59b76a51dbc67f4b76452b2dcbff342530c3869683d";
export const experimentCensusFileSha256 =
  "ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa";
export const experimentCensusCanonicalSha256 =
  "8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d";
export const experimentHistoricalFileSha256 =
  "fd35a9caab3b7ebdc52a999ecabc8e507d72e29c359323d62908de20a4a0bf33";
export const experimentHistoricalCanonicalSha256 =
  "57966b58d5d5ce16ec8ab38a09327052c78b091ad6c3f6db27ebd2cd61b4b49d";

export interface ExperimentFrozenInputs {
  census: {
    canonicalContentSha256: string;
    completenessState: string;
    kind: string;
  };
  censusFileSha256: string;
  censusPath: string;
  historical: HistoricalIdentityEvidenceSnapshot;
  historicalFileSha256: string;
  historicalPath: string;
  manifest: AdaptiveManifest;
  manifestFileSha256: string;
  manifestPath: string;
}

export interface ExperimentControlLabel {
  canonicalArtist: string;
  canonicalArtistId: string;
  evidenceSource: string;
  labelKind: "exact_independent_mapping" | "prior_evidence_confirmed" | "unresolved_control";
  pairedComparison: boolean;
  previousDecisionState: "evidence_confirmed" | "exact_confirmed" | "unresolved";
  previouslySelectedAppleArtistId: string;
}

export interface ExperimentControlArtifact {
  canonicalContentSha256: string;
  controls: ExperimentControlLabel[];
  kind: "itunes_adaptive_identity_control_labels";
  manifestCanonicalContentSha256: string;
  sourceEvaluationPath: string;
  version: 1;
}

export interface MethodDecision {
  candidateIds: string[];
  evidence: string[];
  selectedArtistId: string;
  state: "resolved" | "ambiguous" | "no_useful_evidence";
}

export interface ArtistExperimentDecision {
  albumFirst: MethodDecision;
  canonicalArtist: string;
  canonicalArtistId: string;
  hybrid: MethodDecision;
  stratum: string;
  targetedSearch: MethodDecision;
}

export interface ExperimentExecutionGateInput {
  activeLease: boolean;
  activeRun: boolean;
  branch: string;
  clean: boolean;
  databaseUrl: string | undefined;
  explicitLive: boolean;
  expectedBranch: string;
  expectedCommit: string;
  itunesEnabled: boolean;
  manifestValid: boolean;
  maximumNetworkRequests: number;
  nonItunesDisabled: boolean;
  runtimeMs: number;
  sourceCommit: string;
}

export async function readExperimentFrozenInputs(input: {
  censusPath: string;
  expectedCensusCanonicalSha256: string;
  expectedCensusFileSha256: string;
  expectedHistoricalCanonicalSha256: string;
  expectedHistoricalFileSha256: string;
  expectedManifestCanonicalSha256: string;
  expectedManifestFileSha256: string;
  historicalPath: string;
  manifestPath: string;
}): Promise<ExperimentFrozenInputs> {
  requireExactHash(input.expectedCensusFileSha256, experimentCensusFileSha256, "census file");
  requireExactHash(
    input.expectedCensusCanonicalSha256,
    experimentCensusCanonicalSha256,
    "census canonical",
  );
  requireExactHash(
    input.expectedHistoricalFileSha256,
    experimentHistoricalFileSha256,
    "historical file",
  );
  requireExactHash(
    input.expectedHistoricalCanonicalSha256,
    experimentHistoricalCanonicalSha256,
    "historical canonical",
  );
  requireExactHash(input.expectedManifestFileSha256, experimentManifestFileSha256, "manifest file");
  requireExactHash(
    input.expectedManifestCanonicalSha256,
    experimentManifestCanonicalSha256,
    "manifest canonical",
  );
  const censusPath = resolve(input.censusPath);
  const historicalPath = resolve(input.historicalPath);
  const manifestPath = resolve(input.manifestPath);
  const [censusBytes, historicalBytes, manifestBytes] = await Promise.all([
    readFile(censusPath),
    readFile(historicalPath),
    readFile(manifestPath),
  ]);
  requireExactHash(sha256(censusBytes), input.expectedCensusFileSha256, "census file bytes");
  requireExactHash(
    sha256(historicalBytes),
    input.expectedHistoricalFileSha256,
    "historical file bytes",
  );
  requireExactHash(sha256(manifestBytes), input.expectedManifestFileSha256, "manifest file bytes");
  const census = JSON.parse(censusBytes.toString("utf8")) as ExperimentFrozenInputs["census"];
  const historical = await readHistoricalIdentityEvidence(historicalPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as AdaptiveManifest;
  validateExperimentManifest(manifest);
  if (
    census.kind !== "itunes_full_watchlist_search_census" ||
    census.completenessState !== "complete" ||
    census.canonicalContentSha256 !== input.expectedCensusCanonicalSha256 ||
    historical.canonicalContentSha256 !== input.expectedHistoricalCanonicalSha256 ||
    manifest.canonicalContentSha256 !== input.expectedManifestCanonicalSha256
  ) {
    throw new Error("A frozen artifact canonical hash or completion state differs.");
  }
  return {
    census,
    censusFileSha256: sha256(censusBytes),
    censusPath,
    historical,
    historicalFileSha256: sha256(historicalBytes),
    historicalPath,
    manifest,
    manifestFileSha256: sha256(manifestBytes),
    manifestPath,
  };
}

export function validateExperimentManifest(manifest: AdaptiveManifest): void {
  validateAdaptiveManifest(manifest);
  const requests = manifest.requests;
  const album = requests.filter((request) => request.operationType === "artist_album_lookup");
  const targeted = requests.filter(
    (request) => request.operationType === "targeted_collection_search",
  );
  if (
    manifest.canonicalContentSha256 !==
      adaptiveManifestCanonicalContentSha256(
        objectWithout(manifest, "canonicalContentSha256") as Omit<
          AdaptiveManifest,
          "canonicalContentSha256"
        >,
      ) ||
    manifest.canonicalContentSha256 !== experimentManifestCanonicalSha256 ||
    manifest.artists.length !== experimentArtistCount ||
    new Set(manifest.artists.map((artist) => artist.canonicalArtistId)).size !==
      experimentArtistCount ||
    requests.length !== experimentOperationCount ||
    new Set(requests.map((request) => request.cacheIdentity)).size !== experimentOperationCount ||
    requests.filter((request) => request.cacheHit).length !== 19 ||
    requests.filter((request) => !request.cacheHit).length !== experimentNetworkBudget ||
    album.length !== 73 ||
    targeted.length !== 25
  ) {
    throw new Error("The adaptive experiment manifest differs from its frozen totals.");
  }
  const artistIds = new Set(manifest.artists.map((artist) => artist.canonicalArtistId));
  for (const [index, request] of requests.entries()) {
    if (
      request.requestOrder !== index + 1 ||
      !artistIds.has(request.canonicalArtistId) ||
      !request.canonicalArtist ||
      !request.strategy ||
      !request.reason ||
      request.historicalAnchor === undefined ||
      !request.expectedDecisionContribution ||
      Object.keys(request.normalizedParameters).length === 0
    ) {
      throw new Error("A manifest operation lacks required deterministic attribution.");
    }
    validateOperation(request);
  }
}

export function validateOperation(request: AdaptiveRequest): void {
  if (request.operationType === "artist_album_lookup") {
    const parameters = request.normalizedParameters;
    if (
      request.strategy !== "album_first" ||
      Object.keys(parameters).sort().join(",") !== "country,entity,explicit,id,limit" ||
      parameters.country !== "US" ||
      parameters.entity !== "album" ||
      parameters.explicit !== "Yes" ||
      parameters.limit !== "200" ||
      request.cacheIdentity !== legacyAlbumLookupIdentity(parameters.id ?? "")
    ) {
      throw new Error("Album-first operation is not an exact individual album lookup.");
    }
    return;
  }
  if (request.operationType === "targeted_collection_search") {
    const parameters = request.normalizedParameters;
    if (
      request.strategy !== "targeted_search" ||
      Object.keys(parameters).sort().join(",") !==
        "country,entity,explicit,lang,limit,media,term" ||
      parameters.entity !== "album" ||
      request.cacheIdentity !==
        adaptiveCacheIdentity({
          operationType: request.operationType,
          parameters,
          providerBehaviorVersion: "targeted-search-v1",
          responseNormalizationVersion: "itunes-normalized-v1",
          storefront: "US",
        })
    ) {
      throw new Error("Targeted-search operation differs from the frozen v2 request.");
    }
    return;
  }
  throw new Error("Operation is outside the approved adaptive experiment strategies.");
}

export function validateExperimentExecutionGate(input: ExperimentExecutionGateInput): void {
  const database = input.databaseUrl ? new URL(input.databaseUrl) : null;
  if (
    !database ||
    database.protocol !== "postgres:" ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "55433" ||
    database.pathname !== "/radar_itunes"
  ) {
    throw new Error("Adaptive experiment requires the isolated radar_itunes database.");
  }
  if (!input.explicitLive || !input.itunesEnabled) {
    throw new Error("Adaptive experiment requires explicit live mode and iTunes enablement.");
  }
  if (!input.nonItunesDisabled) {
    throw new Error("Every non-iTunes provider must be disabled and unusable.");
  }
  if (input.activeRun || input.activeLease) {
    throw new Error("Adaptive experiment requires no other active run or request lease.");
  }
  if (!input.manifestValid || input.maximumNetworkRequests !== experimentNetworkBudget) {
    throw new Error("The network budget must exactly equal the frozen 79-request plan.");
  }
  if (!Number.isInteger(input.runtimeMs) || input.runtimeMs < 1 || input.runtimeMs > 900_000) {
    throw new Error("Runtime ceiling must be between 1 ms and 15 minutes.");
  }
  if (
    input.branch !== experimentExpectedBranch ||
    input.branch !== input.expectedBranch ||
    input.sourceCommit !== input.expectedCommit ||
    !input.clean
  ) {
    throw new Error("Adaptive experiment requires the expected clean branch and commit.");
  }
}

export async function generateControlArtifactTwice(input: {
  evaluationPath: string;
  manifest: AdaptiveManifest;
  outputPath: string;
}): Promise<{ artifact: ExperimentControlArtifact; fileByteSha256: string; outputPath: string }> {
  const first = await buildControlArtifact(input);
  const second = await buildControlArtifact(input);
  const firstText = serializeHashedArtifact(first);
  const secondText = serializeHashedArtifact(second);
  if (first.canonicalContentSha256 !== second.canonicalContentSha256 || firstText !== secondText) {
    throw new Error("Repeated control-label generation was not deterministic.");
  }
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, firstText, "utf8");
  return { artifact: first, fileByteSha256: sha256(Buffer.from(firstText)), outputPath };
}

export async function buildControlArtifact(input: {
  evaluationPath: string;
  manifest: AdaptiveManifest;
}): Promise<ExperimentControlArtifact> {
  const evaluationPath = resolve(input.evaluationPath);
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
    identityProvenance: Array<{
      canonicalArtist: string;
      canonicalArtistId: string;
      selectedAppleArtistId: string;
    }>;
  };
  const provenance = new Map(
    evaluation.identityProvenance.map((row) => [row.canonicalArtistId, row]),
  );
  const paired = pairedArtistIds(input.manifest);
  const controls = input.manifest.artists
    .filter(
      (artist) =>
        provenance.has(artist.canonicalArtistId) || artist.stratum === "original_ambiguous_control",
    )
    .map((artist): ExperimentControlLabel => {
      const label = provenance.get(artist.canonicalArtistId);
      return {
        canonicalArtist: artist.canonicalArtist,
        canonicalArtistId: artist.canonicalArtistId,
        evidenceSource: label
          ? "docs/itunes-pilot-offline-evaluation.json identityProvenance"
          : "frozen manifest original_ambiguous_control stratum",
        labelKind: label ? "prior_evidence_confirmed" : "unresolved_control",
        pairedComparison: Boolean(label && paired.has(artist.canonicalArtistId)),
        previousDecisionState: label ? "evidence_confirmed" : "unresolved",
        previouslySelectedAppleArtistId: label?.selectedAppleArtistId ?? "",
      };
    })
    .sort(compareArtist);
  if (
    controls.filter((label) => label.labelKind === "prior_evidence_confirmed").length !== 13 ||
    controls.filter((label) => label.labelKind === "unresolved_control").length !== 11 ||
    controls.filter((label) => label.pairedComparison).length !== 11
  ) {
    throw new Error("Frozen control-label totals differ.");
  }
  const content = {
    controls,
    kind: "itunes_adaptive_identity_control_labels" as const,
    manifestCanonicalContentSha256: input.manifest.canonicalContentSha256,
    sourceEvaluationPath: evaluationPath,
    version: 1 as const,
  };
  return { ...content, canonicalContentSha256: hashCanonical(content) };
}

export function evaluateArtist(input: {
  albumResponses: Array<{ request: AdaptiveRequest; response: ItunesNormalizedResponse }>;
  artist: HistoricalIdentityArtist;
  targetedResponses: Array<{ request: AdaptiveRequest; response: ItunesNormalizedResponse }>;
  stratum: string;
}): ArtistExperimentDecision {
  const albumDecisions = input.albumResponses.map(({ request, response }) =>
    albumFirstDecision(input.artist, request.normalizedParameters.id ?? "", response),
  );
  const targetedDecisions = input.targetedResponses.map(({ request, response }) =>
    targetedDecision(input.artist, request, response),
  );
  const albumFirst = mergeMethodDecisions(albumDecisions);
  const targetedSearch = mergeMethodDecisions(targetedDecisions);
  const hybrid =
    albumFirst.state === "resolved" &&
    targetedSearch.state === "resolved" &&
    albumFirst.selectedArtistId !== targetedSearch.selectedArtistId
      ? ambiguousDecision(unique([...albumFirst.candidateIds, ...targetedSearch.candidateIds]), [
          "Conflicting deterministic method selections preserve ambiguity.",
        ])
      : albumFirst.state === "resolved"
        ? albumFirst
        : targetedSearch.state === "resolved"
          ? targetedSearch
          : ambiguousDecision(
              unique([...albumFirst.candidateIds, ...targetedSearch.candidateIds]),
              unique([...albumFirst.evidence, ...targetedSearch.evidence]),
            );
  return {
    albumFirst,
    canonicalArtist: input.artist.displayName,
    canonicalArtistId: input.artist.canonicalArtistId,
    hybrid,
    stratum: input.stratum,
    targetedSearch,
  };
}

export function albumFirstDecision(
  artist: HistoricalIdentityArtist,
  candidateId: string,
  response: ItunesNormalizedResponse,
): MethodDecision {
  const catalog: ItunesIdentityCandidateCatalog = {
    candidate: {
      artistId: candidateId,
      artistName: compatibleNameForId(artist, candidateId, response.collections),
    },
    collections: response.collections.map((collection) => ({
      ...(collection.artistId ? { artistId: collection.artistId } : {}),
      ...(collection.artistName ? { artistName: collection.artistName } : {}),
      ...(collection.collectionArtistId
        ? { collectionArtistId: collection.collectionArtistId }
        : {}),
      ...(collection.collectionArtistName
        ? { collectionArtistName: collection.collectionArtistName }
        : {}),
      collectionId: collection.collectionId,
      collectionName: collection.collectionName,
      releaseDate: collection.releaseDate,
      source: "album_lookup" as const,
      ...(collection.trackCount === undefined ? {} : { trackCount: collection.trackCount }),
    })),
    tracks: [],
  };
  return fromMappingDecision(
    resolveItunesArtistFromCatalogEvidence({
      aliases: artist.aliases,
      candidates: [catalog],
      canonicalName: artist.displayName,
      groundTruth: groundTruth(artist),
    }),
    [candidateId],
  );
}

export function targetedDecision(
  artist: HistoricalIdentityArtist,
  request: AdaptiveRequest,
  response: ItunesNormalizedResponse,
): MethodDecision {
  const anchor = normalizeText(request.historicalAnchor);
  if (!anchor || genericTitle(anchor)) {
    return ambiguousDecision(candidateIds(response.collections), [
      "Generic or absent historical title cannot confirm identity.",
    ]);
  }
  const anchorRelease = artist.releases.find(
    (release) => normalizeText(release.originalTitle) === anchor,
  );
  if (
    !anchorRelease ||
    !anchorRelease.usableForStrongIdentity ||
    !anchorRelease.primaryCreditedArtistIds.includes(artist.spotifyArtistId)
  ) {
    return ambiguousDecision(candidateIds(response.collections), [
      "Feature-only, excluded, or unfrozen historical evidence cannot confirm identity.",
    ]);
  }
  const compatible = response.collections.filter(
    (collection) =>
      normalizeText(collection.collectionName) === anchor &&
      compatibleArtistName(artist, collection),
  );
  const grouped = new Map<string, ItunesCollection[]>();
  for (const collection of compatible) {
    const id = collection.collectionArtistId ?? collection.artistId;
    if (!id) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), collection]);
  }
  const corroborated = [...grouped.entries()]
    .filter(([, collections]) =>
      collections.every((collection) => versionCompatible(anchor, collection)),
    )
    .map(([id]) => id)
    .sort(compareText);
  if (corroborated.length !== 1) {
    return ambiguousDecision(candidateIds(compatible), [
      "Targeted search did not produce one uniquely corroborated artist ID.",
    ]);
  }
  const selected = corroborated[0]!;
  return {
    candidateIds: candidateIds(response.collections),
    evidence: [
      `exact_distinctive_title:${request.historicalAnchor}`,
      `compatible_artist_credit:${selected}`,
      "search_rank_not_used",
    ],
    selectedArtistId: selected,
    state: "resolved",
  };
}

function fromMappingDecision(
  decision: ItunesMappingDecision,
  candidates: string[],
): MethodDecision {
  return decision.status === "evidence_confirmed" && decision.selected
    ? {
        candidateIds: unique(candidates),
        evidence: decision.evidence,
        selectedArtistId: decision.selected.artistId,
        state: "resolved",
      }
    : ambiguousDecision(candidates, [
        decision.reason,
        ...(decision.ambiguityReason ? [decision.ambiguityReason] : []),
      ]);
}

function groundTruth(artist: HistoricalIdentityArtist): SpotifyGroundTruthRelease[] {
  return artist.releases
    .filter((release) => release.usableForStrongIdentity)
    .map((release) => ({
      canonicalReleaseId: release.spotifyReleaseId,
      normalizedTitle: release.normalizedTitle,
      releaseDate: release.releaseDate,
      releaseType: release.releaseType,
      spotifyReleaseId: release.spotifyReleaseId,
      title: release.originalTitle,
      totalTracks: release.totalTrackCount,
      tracks: release.tracks
        .filter((track) => track.usableForStrongIdentity)
        .map((track) => ({
          normalizedTitle: track.normalizedTitle,
          title: track.originalTitle,
        })),
      version: release.versionMarkers.join(" "),
    }));
}

function compatibleNameForId(
  artist: HistoricalIdentityArtist,
  candidateId: string,
  collections: ItunesCollection[],
): string {
  const matching = collections.find(
    (collection) =>
      collection.artistId === candidateId || collection.collectionArtistId === candidateId,
  );
  return matching?.collectionArtistName ?? matching?.artistName ?? artist.displayName;
}

function compatibleArtistName(
  artist: HistoricalIdentityArtist,
  collection: ItunesCollection,
): boolean {
  const allowed = new Set(
    [artist.displayName, ...artist.aliases].map(normalizeArtistIdentity).filter(Boolean),
  );
  return [collection.artistName, collection.collectionArtistName]
    .filter((value): value is string => Boolean(value))
    .some((value) => allowed.has(normalizeArtistIdentity(value)));
}

function versionCompatible(anchor: string, collection: ItunesCollection): boolean {
  const title = normalizeText(collection.collectionName);
  const markers = ["remix", "live", "edit", "remaster", "mix", "vip"];
  return markers.every((marker) => title.includes(marker) === anchor.includes(marker));
}

function genericTitle(title: string): boolean {
  return new Set(["alive", "dream", "forever", "home", "intro", "love", "run", "stay", "you"]).has(
    title,
  );
}

function candidateIds(collections: ItunesCollection[]): string[] {
  return unique(
    collections.flatMap((collection) =>
      [collection.collectionArtistId, collection.artistId].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  );
}

function mergeMethodDecisions(decisions: MethodDecision[]): MethodDecision {
  const resolved = decisions.filter((decision) => decision.state === "resolved");
  const selected = unique(resolved.map((decision) => decision.selectedArtistId));
  const candidates = unique(decisions.flatMap((decision) => decision.candidateIds));
  const evidence = unique(decisions.flatMap((decision) => decision.evidence));
  return selected.length === 1
    ? { candidateIds: candidates, evidence, selectedArtistId: selected[0]!, state: "resolved" }
    : ambiguousDecision(candidates, evidence);
}

function ambiguousDecision(candidateIdsValue: string[], evidence: string[]): MethodDecision {
  return {
    candidateIds: unique(candidateIdsValue),
    evidence: unique(evidence),
    selectedArtistId: "",
    state: candidateIdsValue.length === 0 ? "no_useful_evidence" : "ambiguous",
  };
}

function pairedArtistIds(manifest: AdaptiveManifest): Set<string> {
  const strategies = new Map<string, Set<string>>();
  for (const request of manifest.requests) {
    strategies.set(
      request.canonicalArtistId,
      new Set([...(strategies.get(request.canonicalArtistId) ?? []), request.strategy]),
    );
  }
  return new Set(
    [...strategies.entries()]
      .filter(([, values]) => values.has("album_first") && values.has("targeted_search"))
      .map(([id]) => id),
  );
}

export function serializeHashedArtifact(value: { canonicalContentSha256: string }): string {
  const { canonicalContentSha256, ...content } = value;
  if (hashCanonical(content) !== canonicalContentSha256) {
    throw new Error("Artifact canonical-content hash differs.");
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashCanonical(value: unknown): string {
  return sha256(Buffer.from(stableJson(value), "utf8"));
}

function objectWithout(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
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

function requireExactHash(actual: string, expected: string, name: string): void {
  if (actual !== expected) throw new Error(`Frozen ${name} SHA-256 differs.`);
}

function compareArtist(left: ExperimentControlLabel, right: ExperimentControlLabel): number {
  return compareText(left.canonicalArtistId, right.canonicalArtistId);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort(compareText);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
