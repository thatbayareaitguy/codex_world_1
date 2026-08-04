import {
  decideAppleMusicArtistMapping,
  selectAppleMusicCatalogEvidenceCandidates,
  type AppleMusicArtistCandidate,
  type AppleMusicMappingDecision,
  type resolveAppleMusicArtistFromCatalogEvidence,
} from "@radar/core";
import {
  AppleMusicClientError,
  type AppleMusicAlbum,
  type AppleMusicArtist,
  type AppleMusicArtistSongViewPage,
  type AppleMusicArtistView,
  type AppleMusicArtistViewPage,
  type AppleMusicRecentSearchPage,
  type AppleMusicSong,
} from "@radar/providers";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import { resolveAppleMusicMappingFromTopSongs } from "./apple-music-catalog-evidence";
import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import type { AppleMusicPilotPlanArtist } from "./apple-music-pilot-definition";
import {
  appleMusicRecentConfirmation,
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
  appleMusicRecentWindow,
  classifyAppleMusicRecentCandidate,
  compareAppleMusicRecentCandidate,
  mergeAppleMusicRecentCandidates,
  scopedAppleMusicRecentGroundTruth,
  type AppleMusicRecentCandidate,
  type AppleMusicRecentSource,
} from "./apple-music-recent";
import type {
  ItunesPilotGroundTruthRelease,
  ItunesPilotSnapshot,
  ItunesPilotSnapshotArtist,
} from "./itunes-pilot-snapshot";
import {
  appleMusicRecentValidationConfirmation,
  type AppleMusicRecentValidationManifest,
  validateAppleMusicRecentValidationManifest,
} from "./apple-music-recent-validation";
import {
  appleMusicRecentSeedDiscoveryArtists,
  appleMusicRecentSeedDiscoveryConfirmation,
  type AppleMusicRecentSeedDiscoveryManifest,
  validateAppleMusicRecentSeedDiscoveryManifest,
} from "./apple-music-recent-seed-discovery";

const authorizationMarker = Symbol("apple-music-recent-authorization");

export interface AppleMusicRecentAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation:
    | typeof appleMusicRecentConfirmation
    | typeof appleMusicRecentSeedDiscoveryConfirmation
    | typeof appleMusicRecentValidationConfirmation;
  readonly evaluationAsOf: typeof appleMusicRecentEvaluationTime;
  readonly persistentProviderEnabled: false;
  readonly storefront: "us";
  readonly scope: "sample" | "seed_discovery_5" | "validation_25";
}

export interface AppleMusicRecentClient {
  getArtist(id: string): Promise<AppleMusicArtist | undefined>;
  getArtistAlbumsFirstPage(
    artistId: string,
    identityScope: string,
  ): Promise<AppleMusicArtistViewPage>;
  getArtistViewFirstPage(
    artistId: string,
    view: AppleMusicArtistView,
    signal?: AbortSignal,
    identityScope?: string,
  ): Promise<AppleMusicArtistViewPage>;
  getArtistTopSongsFirstPage(
    artistId: string,
    identityScope: string,
    signal?: AbortSignal,
  ): Promise<AppleMusicArtistSongViewPage>;
  searchArtists(term: string): Promise<AppleMusicArtist[]>;
  searchRecentRemixes(term: string, identityScope: string): Promise<AppleMusicRecentSearchPage>;
}

type AppleMusicRecentAvailability =
  "available_with_results" | "available_empty" | "unavailable_404" | "failed";

export interface AppleMusicRecentStore {
  claimLease(runId: string): Promise<string>;
  createRun(input: {
    implementationCommit: string;
    maximumRuntimeMs: number;
    minRequestIntervalMs: number;
    requestBudget: number;
    snapshotId: string;
  }): Promise<{ id: string }>;
  findConfirmedMapping(input: {
    canonicalArtistId: string;
    snapshotId: string;
  }): Promise<{ appleArtistId: string } | undefined>;
  finishRun(
    runId: string,
    input: {
      metrics: Record<string, unknown>;
      status: "completed" | "controlled_partial" | "failed";
      stopReason: string;
    },
  ): Promise<void>;
  importSnapshot(snapshot: ItunesPilotSnapshot): Promise<string>;
  lastSuccessfulCompletedAt(): Promise<Date | undefined>;
  operationalStatus(): Promise<{ cooldownActive: boolean; leaseActive: boolean }>;
  readEvidence(runId: string): Promise<AppleMusicPilotStoredEvidence>;
  releaseLease(leaseToken: string): Promise<void>;
  saveCandidates(input: {
    candidates: Array<AppleMusicRecentCandidate & { comparisonStatus: string }>;
    canonicalArtistId: string;
    runId: string;
  }): Promise<void>;
  saveCatalog(input: {
    albums: AppleMusicAlbum[];
    canonicalArtistId: string;
    runId: string;
    songs: AppleMusicSong[];
  }): Promise<void>;
  saveMapping(input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    inheritedItunesArtistId?: string;
    runId: string;
  }): Promise<void>;
}

export interface AppleMusicRecentRunSummary {
  artists: Array<{
    armA: { candidates: number; requests: number };
    armB: { candidates: number; requests: number };
    armC: { candidates: number; requests: number };
    artist: string;
    candidates: Array<{
      albumTitle: string;
      classification: AppleMusicRecentCandidate["classification"];
      comparisonTitle: string;
      comparisonStatus: string;
      eligible: boolean;
      granularity: AppleMusicRecentCandidate["granularity"];
      releaseDate?: string;
      songTitle?: string;
      sources: AppleMusicRecentSource[];
      title: string;
    }>;
    groundTruth: Array<{ date: string; title: string; type: string }>;
    mapping: AppleMusicMappingDecision["status"];
  }>;
  evidence: AppleMusicPilotStoredEvidence;
  evaluationAsOf: string;
  mode: "recent_mvp";
  requestBudget: 100;
  runId: string;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
  window: { effectiveEnd: string; effectiveStart: string };
}

export interface AppleMusicRecentOptimizationSummary {
  artists: Array<{
    artist: string;
    candidates: Array<{
      albumTitle: string;
      classification: AppleMusicRecentCandidate["classification"];
      comparisonTitle: string;
      comparisonStatus: string;
      eligible: boolean;
      granularity: AppleMusicRecentCandidate["granularity"];
      releaseDate?: string;
      songTitle?: string;
      sources: AppleMusicRecentSource[];
      title: string;
    }>;
    groundTruth: Array<{ date: string; title: string; type: string }>;
    fullAlbums: {
      candidates: number;
      nextPresent: boolean;
      requests: number;
      status: AppleMusicRecentAvailability;
    };
    mapping: AppleMusicMappingDecision["status"];
    search: {
      albumsNextPresent: boolean;
      candidates: number;
      requests: number;
      songsNextPresent: boolean;
      status: AppleMusicRecentAvailability;
    };
    singles: {
      candidates: number;
      nextPresent: boolean;
      requests: number;
      status: AppleMusicRecentAvailability;
    };
    topSongs: {
      candidates: number;
      nextPresent: boolean;
      requests: number;
      status: AppleMusicRecentAvailability;
    };
  }>;
  evidence: AppleMusicPilotStoredEvidence;
  evaluationAsOf: string;
  mode:
    | "recent_optimized_four_source"
    | "recent_optimized_seed_discovery_5"
    | "recent_optimized_validation_25";
  requestBudget: 25 | 175;
  runId: string;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
  window: { effectiveEnd: string; effectiveStart: string };
}

export function authorizeAppleMusicRecent(input: {
  confirmation?: string;
  evaluationAsOf?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
  scope?: "sample" | "seed_discovery_5" | "validation_25";
}): AppleMusicRecentAuthorization {
  if (!input.executeLive) throw new Error("Live Apple recent execution requires --execute-live.");
  const scope = input.scope ?? "sample";
  const requiredConfirmation =
    scope === "validation_25"
      ? appleMusicRecentValidationConfirmation
      : scope === "seed_discovery_5"
        ? appleMusicRecentSeedDiscoveryConfirmation
        : appleMusicRecentConfirmation;
  if (input.confirmation !== requiredConfirmation) {
    throw new Error(`Live execution requires --confirm-live ${requiredConfirmation}.`);
  }
  if (input.evaluationAsOf !== appleMusicRecentEvaluationTime) {
    throw new Error(`Live execution requires evaluation time ${appleMusicRecentEvaluationTime}.`);
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) {
    throw new Error("Every non-Apple provider must be disabled.");
  }
  if (input.storefront !== "us") throw new Error("The Apple recent MVP requires US storefront.");
  return Object.freeze({
    [authorizationMarker]: true as const,
    confirmation: requiredConfirmation,
    evaluationAsOf: appleMusicRecentEvaluationTime,
    persistentProviderEnabled: false as const,
    storefront: "us" as const,
    scope,
  });
}

export async function runAppleMusicRecent(input: {
  authorization: AppleMusicRecentAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
  implementationCommit: string;
  now?: () => Date;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicRecentStore;
}): Promise<AppleMusicRecentRunSummary> {
  assertAuthorization(input.authorization);
  const cohort = validateAppleMusicPilotSnapshot(input.snapshot);
  const entries = appleMusicRecentSample.map((name) => {
    const entry = cohort.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`Recent sample artist ${name} is missing.`);
    return entry;
  });
  return runAppleMusicRecentAfterValidation(input, entries);
}

export async function runAppleMusicRecentAfterValidation(
  input: {
    authorization: AppleMusicRecentAuthorization;
    createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
    implementationCommit: string;
    now?: () => Date;
    snapshot: ItunesPilotSnapshot;
    store: AppleMusicRecentStore;
  },
  entries: AppleMusicPilotPlanArtist[],
): Promise<AppleMusicRecentRunSummary> {
  assertAuthorization(input.authorization);
  if (
    entries.length !== appleMusicRecentSample.length ||
    entries.some((entry, index) => entry.name !== appleMusicRecentSample[index])
  ) {
    throw new Error("The Apple recent runner requires the exact ordered 10-artist sample.");
  }
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) throw new Error("Apple Music has an active cooldown.");
  if (operational.leaseActive) throw new Error("Apple Music has an active lease.");
  const previousSuccess = await input.store.lastSuccessfulCompletedAt();
  const evaluationEnd = new Date(input.authorization.evaluationAsOf);
  const window = appleMusicRecentWindow(evaluationEnd, previousSuccess);
  const snapshotId = await input.store.importSnapshot(input.snapshot);
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: 900_000,
    minRequestIntervalMs: 1_100,
    requestBudget: 100,
    snapshotId,
  });
  let leaseToken: string | undefined;
  let status: AppleMusicRecentRunSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  const artists: AppleMusicRecentRunSummary["artists"] = [];
  const systematicBadRequests = new Map<string, number>();
  let summary: AppleMusicRecentRunSummary | undefined;
  try {
    leaseToken = await input.store.claimLease(run.id);
    const client = input.createClient(run.id, leaseToken);
    const identityScope = `recent:${run.id}`;
    for (const entry of entries) {
      const source = snapshotArtist(input.snapshot, entry.canonicalArtistId);
      const decision = await resolveMapping(
        client,
        input.store,
        snapshotId,
        source,
        input.snapshot.groundTruthReleases.filter(
          (release) => release.canonicalArtistId === source.canonicalArtistId,
        ),
        entry.knownAppleArtistId,
        identityScope,
      );
      await input.store.saveMapping({
        canonicalArtistId: source.canonicalArtistId,
        decision,
        ...(entry.knownAppleArtistId ? { inheritedItunesArtistId: entry.knownAppleArtistId } : {}),
        runId: run.id,
      });
      const groundTruth = scopedAppleMusicRecentGroundTruth(input.snapshot, source, evaluationEnd);
      if (!decision.selected) {
        artists.push({
          armA: { candidates: 0, requests: 0 },
          armB: { candidates: 0, requests: 0 },
          armC: { candidates: 0, requests: 0 },
          artist: source.canonicalName,
          candidates: [],
          groundTruth: publicGroundTruth(groundTruth),
          mapping: decision.status,
        });
        continue;
      }
      const collected = await collectArtist(
        client,
        decision.selected.artistId,
        source,
        window,
        identityScope,
        systematicBadRequests,
      );
      const withComparison = collected.all.map((candidate) => ({
        ...candidate,
        comparisonStatus: compareAppleMusicRecentCandidate(candidate, groundTruth),
      }));
      await input.store.saveCatalog({
        albums: collected.albums,
        canonicalArtistId: source.canonicalArtistId,
        runId: run.id,
        songs: collected.songs,
      });
      await input.store.saveCandidates({
        candidates: withComparison,
        canonicalArtistId: source.canonicalArtistId,
        runId: run.id,
      });
      artists.push({
        armA: {
          candidates: collected.armA.filter((candidate) => candidate.eligible).length,
          requests: collected.armARequests,
        },
        armB: {
          candidates: collected.armB.filter((candidate) => candidate.eligible).length,
          requests: collected.armBRequests,
        },
        armC: {
          candidates: collected.armC.filter((candidate) => candidate.eligible).length,
          requests: collected.armCRequests,
        },
        artist: source.canonicalName,
        candidates: withComparison.map((candidate) => ({
          albumTitle: candidate.albumTitle,
          classification: candidate.classification,
          comparisonTitle: candidate.comparisonTitle,
          comparisonStatus: candidate.comparisonStatus,
          eligible: candidate.eligible,
          granularity: candidate.granularity,
          ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {}),
          ...(candidate.songTitle ? { songTitle: candidate.songTitle } : {}),
          sources: candidate.sources,
          title: candidate.comparisonTitle,
        })),
        groundTruth: publicGroundTruth(groundTruth),
        mapping: decision.status,
      });
    }
    status = "completed";
    stopReason = "recent_sample_completed";
  } catch (error) {
    const classified = classifyTerminal(error);
    status = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      const evidence = await input.store.readEvidence(run.id);
      summary = {
        artists,
        evidence,
        evaluationAsOf: input.authorization.evaluationAsOf,
        mode: "recent_mvp",
        requestBudget: 100,
        runId: run.id,
        status,
        stopReason,
        window: {
          effectiveEnd: window.effectiveEnd.toISOString(),
          effectiveStart: window.effectiveStart.toISOString(),
        },
      };
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("Apple recent summary was not created.");
  return summary;
}

export async function runAppleMusicRecentOptimization(input: {
  authorization: AppleMusicRecentAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
  implementationCommit: string;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicRecentStore;
}): Promise<AppleMusicRecentOptimizationSummary> {
  assertAuthorization(input.authorization);
  const cohort = validateAppleMusicPilotSnapshot(input.snapshot);
  const entries = appleMusicRecentSample.map((name) => {
    const entry = cohort.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`Recent sample artist ${name} is missing.`);
    return entry;
  });
  return runAppleMusicRecentOptimizationAfterValidation(input, entries, {
    freshSupplementOnly: true,
  });
}

export async function runAppleMusicRecentValidation(input: {
  authorization: AppleMusicRecentAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
  implementationCommit: string;
  manifest: AppleMusicRecentValidationManifest;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicRecentStore;
}): Promise<AppleMusicRecentOptimizationSummary> {
  assertAuthorization(input.authorization);
  if (input.authorization.scope !== "validation_25") {
    throw new Error("The validation runner requires validation_25 authorization.");
  }
  const manifest = validateAppleMusicRecentValidationManifest(input.manifest, input.snapshot);
  const entries = manifest.artists.map((manifestArtist) => {
    const artist = input.snapshot.artists.find(
      (candidate) => candidate.canonicalName === manifestArtist.name,
    );
    if (!artist) throw new Error(`Validation artist ${manifestArtist.name} is missing.`);
    return {
      canonicalArtistId: artist.canonicalArtistId,
      category: "identity_catalog_stress" as const,
      name: artist.canonicalName,
      requiresSearch: true,
    };
  });
  return runAppleMusicRecentOptimizationAfterValidation(input, entries, {
    freshSupplementOnly: false,
    validation: true,
  });
}

export async function runAppleMusicRecentSeedDiscovery(input: {
  authorization: AppleMusicRecentAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
  implementationCommit: string;
  manifest: AppleMusicRecentSeedDiscoveryManifest;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicRecentStore;
  validateSnapshot?: typeof validateAppleMusicPilotSnapshot;
}): Promise<AppleMusicRecentOptimizationSummary> {
  assertAuthorization(input.authorization);
  if (input.authorization.scope !== "seed_discovery_5") {
    throw new Error("The seed-discovery runner requires seed_discovery_5 authorization.");
  }
  const manifest = validateAppleMusicRecentSeedDiscoveryManifest(
    input.manifest,
    input.snapshot,
    input.validateSnapshot,
  );
  const entries = manifest.artists.map((manifestArtist) => {
    const artist = input.snapshot.artists.find(
      (candidate) => candidate.canonicalName === manifestArtist.name,
    );
    if (!artist) throw new Error(`Seed-discovery artist ${manifestArtist.name} is missing.`);
    return {
      canonicalArtistId: artist.canonicalArtistId,
      category: "positive_release" as const,
      name: artist.canonicalName,
      requiresSearch: false,
    };
  });
  return runAppleMusicRecentOptimizationAfterValidation(input, entries, {
    confirmedSubset: true,
    freshSupplementOnly: false,
  });
}

export async function runAppleMusicRecentOptimizationAfterValidation(
  input: {
    authorization: AppleMusicRecentAuthorization;
    createClient(runId: string, leaseToken: string): AppleMusicRecentClient;
    implementationCommit: string;
    snapshot: ItunesPilotSnapshot;
    store: AppleMusicRecentStore;
  },
  entries: AppleMusicPilotPlanArtist[],
  options: { confirmedSubset?: boolean; freshSupplementOnly: boolean; validation?: boolean },
): Promise<AppleMusicRecentOptimizationSummary> {
  assertAuthorization(input.authorization);
  if (options.validation) {
    if (entries.length !== 25) throw new Error("Validation requires exactly 25 artists.");
  } else if (options.confirmedSubset) {
    if (
      entries.length !== appleMusicRecentSeedDiscoveryArtists.length ||
      entries.some((entry, index) => entry.name !== appleMusicRecentSeedDiscoveryArtists[index]) ||
      input.authorization.scope !== "seed_discovery_5"
    ) {
      throw new Error("Seed discovery requires the exact ordered five-artist scope.");
    }
  } else {
    assertExactRecentSample(entries);
  }
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) throw new Error("Apple Music has an active cooldown.");
  if (operational.leaseActive) throw new Error("Apple Music has an active lease.");
  const evaluationEnd = new Date(input.authorization.evaluationAsOf);
  const window = appleMusicRecentWindow(evaluationEnd);
  const snapshotId = await input.store.importSnapshot(input.snapshot);
  const mappings = new Map<string, string>();
  if (!options.validation) {
    for (const entry of entries) {
      const mapping = await input.store.findConfirmedMapping({
        canonicalArtistId: entry.canonicalArtistId,
        snapshotId,
      });
      if (!mapping) {
        throw new Error(`A confirmed Apple mapping is required for ${entry.name}.`);
      }
      mappings.set(entry.canonicalArtistId, mapping.appleArtistId);
    }
  }
  const requestBudget = options.validation ? (175 as const) : (25 as const);
  const maximumRuntimeMs = options.validation ? 1_200_000 : 300_000;
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs,
    minRequestIntervalMs: 1_100,
    requestBudget,
    snapshotId,
  });
  let leaseToken: string | undefined;
  let status: AppleMusicRecentOptimizationSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  const artists: AppleMusicRecentOptimizationSummary["artists"] = [];
  const systematicBadRequests = new Map<string, number>();
  let summary: AppleMusicRecentOptimizationSummary | undefined;
  try {
    leaseToken = await input.store.claimLease(run.id);
    const client = input.createClient(run.id, leaseToken);
    const identityScope = `recent-optimized:${run.id}`;
    for (const entry of entries) {
      const source = snapshotArtist(input.snapshot, entry.canonicalArtistId);
      const artistId = mappings.get(entry.canonicalArtistId);
      const decision = options.validation
        ? await resolveMapping(
            client,
            input.store,
            snapshotId,
            source,
            input.snapshot.groundTruthReleases.filter(
              (release) => release.canonicalArtistId === source.canonicalArtistId,
            ),
            undefined,
            identityScope,
          )
        : confirmedMappingDecision(
            source,
            artistId ??
              (() => {
                throw new Error("A prevalidated Apple mapping was lost.");
              })(),
          );
      if (!options.confirmedSubset) {
        await input.store.saveMapping({
          canonicalArtistId: source.canonicalArtistId,
          decision,
          runId: run.id,
        });
      }
      const groundTruth = scopedAppleMusicRecentGroundTruth(input.snapshot, source, evaluationEnd);
      if (!decision.selected) {
        artists.push({
          artist: source.canonicalName,
          candidates: [],
          fullAlbums: emptySourceSummary(),
          groundTruth: publicGroundTruth(groundTruth),
          mapping: decision.status,
          search: {
            albumsNextPresent: false,
            candidates: 0,
            requests: 0,
            songsNextPresent: false,
            status: "available_empty",
          },
          singles: emptySourceSummary(),
          topSongs: emptySourceSummary(),
        });
        continue;
      }
      const collected = await collectOptimizedArtist(
        client,
        decision.selected.artistId,
        source,
        window,
        identityScope,
        systematicBadRequests,
        options.freshSupplementOnly,
      );
      const withComparison = collected.all.map((candidate) => ({
        ...candidate,
        comparisonStatus: compareAppleMusicRecentCandidate(candidate, groundTruth),
      }));
      await input.store.saveCatalog({
        albums: collected.albums,
        canonicalArtistId: source.canonicalArtistId,
        runId: run.id,
        songs: collected.songs,
      });
      await input.store.saveCandidates({
        candidates: withComparison,
        canonicalArtistId: source.canonicalArtistId,
        runId: run.id,
      });
      artists.push({
        artist: source.canonicalName,
        candidates: withComparison.map((candidate) => ({
          albumTitle: candidate.albumTitle,
          classification: candidate.classification,
          comparisonTitle: candidate.comparisonTitle,
          comparisonStatus: candidate.comparisonStatus,
          eligible: candidate.eligible,
          granularity: candidate.granularity,
          ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {}),
          ...(candidate.songTitle ? { songTitle: candidate.songTitle } : {}),
          sources: candidate.sources,
          title: candidate.comparisonTitle,
        })),
        groundTruth: publicGroundTruth(groundTruth),
        fullAlbums: {
          candidates: collected.fullAlbums.page.items.length,
          nextPresent: collected.fullAlbums.page.nextPresent,
          requests: collected.fullAlbums.requested,
          status: collected.fullAlbums.status,
        },
        mapping: decision.status,
        search: {
          albumsNextPresent: collected.search.page.albumsNextPresent,
          candidates: collected.searchCandidates,
          requests: collected.search.requested,
          songsNextPresent: collected.search.page.songsNextPresent,
          status: collected.search.status,
        },
        singles: {
          candidates: collected.singles.page.items.length,
          nextPresent: collected.singles.page.nextPresent,
          requests: collected.singles.requested,
          status: collected.singles.status,
        },
        topSongs: {
          candidates: collected.topSongCandidates,
          nextPresent: collected.topSongs.page.nextPresent,
          requests: collected.topSongs.requested,
          status: collected.topSongs.status,
        },
      });
    }
    status = "completed";
    stopReason = options.validation
      ? "recent_optimized_validation_25_completed"
      : options.confirmedSubset
        ? "recent_optimized_seed_discovery_5_completed"
        : "recent_optimized_sample_completed";
  } catch (error) {
    const classified = classifyTerminal(error);
    status = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      const evidence = await input.store.readEvidence(run.id);
      summary = {
        artists,
        evidence,
        evaluationAsOf: input.authorization.evaluationAsOf,
        mode: options.validation
          ? "recent_optimized_validation_25"
          : options.confirmedSubset
            ? "recent_optimized_seed_discovery_5"
            : "recent_optimized_four_source",
        requestBudget,
        runId: run.id,
        status,
        stopReason,
        window: {
          effectiveEnd: window.effectiveEnd.toISOString(),
          effectiveStart: window.effectiveStart.toISOString(),
        },
      };
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("Apple recent optimization summary was not created.");
  return summary;
}

function assertExactRecentSample(entries: AppleMusicPilotPlanArtist[]): void {
  if (
    entries.length !== appleMusicRecentSample.length ||
    entries.some((entry, index) => entry.name !== appleMusicRecentSample[index])
  ) {
    throw new Error("The Apple recent runner requires the exact ordered 10-artist sample.");
  }
}

function confirmedMappingDecision(
  artist: ItunesPilotSnapshotArtist,
  artistId: string,
): AppleMusicMappingDecision {
  return {
    candidates: [],
    confidence: 1,
    evidence: [],
    reason: "A safely confirmed Apple mapping was reused.",
    selected: {
      artistId,
      genreNames: [],
      name: artist.canonicalName,
    },
    status: "evidence_confirmed",
  };
}

async function resolveMapping(
  client: AppleMusicRecentClient,
  store: AppleMusicRecentStore,
  snapshotId: string,
  artist: ItunesPilotSnapshotArtist,
  groundTruth: ItunesPilotGroundTruthRelease[],
  knownId?: string,
  identityScope = "recent-cold-start",
): Promise<AppleMusicMappingDecision> {
  const existing = await store.findConfirmedMapping({
    canonicalArtistId: artist.canonicalArtistId,
    snapshotId,
  });
  if (existing) {
    return {
      candidates: [],
      confidence: 1,
      evidence: [],
      reason: "A safely confirmed Apple mapping was reused.",
      selected: {
        artistId: existing.appleArtistId,
        genreNames: [],
        name: artist.canonicalName,
      },
      status: "evidence_confirmed",
    };
  }
  if (knownId) {
    const resolved = await client.getArtist(knownId);
    if (resolved) {
      const decision = decideAppleMusicArtistMapping({
        aliases: artist.aliases,
        canonicalName: artist.canonicalName,
        existingArtist: resolved,
        existingArtistId: knownId,
        searchCandidates: [],
      });
      if (decision.selected) return decision;
    }
  }
  const searchCandidates = await client.searchArtists(artist.canonicalName);
  return resolveColdStartAppleMusicMapping({
    aliases: artist.aliases,
    canonicalName: artist.canonicalName,
    client,
    groundTruth,
    identityScope,
    searchCandidates,
  });
}

export async function resolveColdStartAppleMusicMapping(input: {
  aliases: string[];
  canonicalName: string;
  client: Pick<AppleMusicRecentClient, "getArtistTopSongsFirstPage">;
  groundTruth: ItunesPilotGroundTruthRelease[];
  identityScope: string;
  resolver?: typeof resolveAppleMusicArtistFromCatalogEvidence;
  searchCandidates: AppleMusicArtistCandidate[];
}): Promise<AppleMusicMappingDecision> {
  const initial = decideAppleMusicArtistMapping({
    aliases: input.aliases,
    canonicalName: input.canonicalName,
    searchCandidates: input.searchCandidates,
  });
  if (initial.status !== "ambiguous") return initial;
  const eligible = selectAppleMusicCatalogEvidenceCandidates({
    aliases: input.aliases,
    candidates: input.searchCandidates,
    canonicalName: input.canonicalName,
    maximumCandidates: input.searchCandidates.length,
  });
  if (eligible.length < 2) return initial;
  const candidateEvidence = [];
  let complete = true;
  for (const candidate of eligible) {
    try {
      const page = await input.client.getArtistTopSongsFirstPage(
        candidate.artistId,
        input.identityScope,
      );
      candidateEvidence.push({ artist: candidate, songs: page.items });
    } catch (error) {
      if (!isNonterminalIdentityEvidenceError(error)) throw error;
      complete = false;
      candidateEvidence.push({ artist: candidate, songs: [] });
    }
  }
  if (!complete) return initial;
  return resolveAppleMusicMappingFromTopSongs(
    {
      aliases: input.aliases,
      candidateEvidence,
      canonicalName: input.canonicalName,
      groundTruth: input.groundTruth,
    },
    input.resolver,
  );
}

function isNonterminalIdentityEvidenceError(error: unknown): boolean {
  return (
    error instanceof AppleMusicClientError &&
    (error.status === 400 || error.status === 404 || (error.status ?? 0) >= 500)
  );
}

async function collectOptimizedArtist(
  client: AppleMusicRecentClient,
  artistId: string,
  artist: ItunesPilotSnapshotArtist,
  window: ReturnType<typeof appleMusicRecentWindow>,
  identityScope: string,
  badRequests: Map<string, number>,
  freshSupplementOnly: boolean,
) {
  const singles = freshSupplementOnly
    ? emptyAlbumPage()
    : await safePage(
        "singles",
        () => client.getArtistViewFirstPage(artistId, "singles", undefined, identityScope),
        badRequests,
      );
  const fullAlbums = freshSupplementOnly
    ? emptyAlbumPage()
    : await safePage(
        "full-albums",
        () => client.getArtistViewFirstPage(artistId, "full-albums", undefined, identityScope),
        badRequests,
      );
  const topSongs = await safeSongPage(
    "top-songs",
    () => client.getArtistTopSongsFirstPage(artistId, identityScope),
    badRequests,
  );
  const search = await safeSearch(
    () => client.searchRecentRemixes(`${artist.canonicalName} Remix`, identityScope),
    badRequests,
  );
  const inputs: Array<
    | { album: AppleMusicAlbum; confirmed: boolean; source: AppleMusicRecentSource }
    | { song: AppleMusicSong; confirmed: boolean; source: AppleMusicRecentSource }
  > = [
    ...tagAlbums(singles.page.items, "singles", true),
    ...tagAlbums(fullAlbums.page.items, "full-albums", true),
    ...topSongs.page.items.map((song) => ({
      confirmed: true,
      song,
      source: "top-songs" as const,
    })),
    ...tagAlbums(search.page.albums, "catalog-search-album", false),
    ...search.page.songs.map((song) => ({
      confirmed: false,
      song,
      source: "catalog-search-song" as const,
    })),
  ];
  const all = mergeAppleMusicRecentCandidates(
    inputs.map((value) =>
      classifyAppleMusicRecentCandidate({
        aliases: artist.aliases,
        ...("album" in value ? { album: value.album } : { song: value.song }),
        confirmedArtistAssociation: value.confirmed,
        source: value.source,
        watchedArtist: artist.canonicalName,
        window,
      }),
    ),
  );
  return {
    albums: dedupeAlbums([...singles.page.items, ...fullAlbums.page.items, ...search.page.albums]),
    all,
    fullAlbums,
    search,
    searchCandidates: all.filter(
      (candidate) =>
        candidate.sources.includes("catalog-search-album") ||
        candidate.sources.includes("catalog-search-song"),
    ).length,
    songs: dedupeSongs([...topSongs.page.items, ...search.page.songs]),
    singles,
    topSongCandidates: all.filter((candidate) => candidate.sources.includes("top-songs")).length,
    topSongs,
  };
}

function emptySourceSummary() {
  return {
    candidates: 0,
    nextPresent: false,
    requests: 0,
    status: "available_empty" as const,
  };
}

async function collectArtist(
  client: AppleMusicRecentClient,
  artistId: string,
  artist: ItunesPilotSnapshotArtist,
  window: ReturnType<typeof appleMusicRecentWindow>,
  identityScope: string,
  badRequests: Map<string, number>,
) {
  const albums: AppleMusicAlbum[] = [];
  const songs: AppleMusicSong[] = [];
  const fetchView = (view: AppleMusicArtistView) =>
    safePage(
      view,
      () => client.getArtistViewFirstPage(artistId, view, undefined, identityScope),
      badRequests,
    );
  const latest = await fetchView("latest-release");
  const artistAlbums = await safePage(
    "artist-albums",
    () => client.getArtistAlbumsFirstPage(artistId, identityScope),
    badRequests,
  );
  const singles = await fetchView("singles");
  const fullAlbums = await fetchView("full-albums");
  const appears = await fetchView("appears-on-albums");
  const search = await safeSearch(
    () => client.searchRecentRemixes(`${artist.canonicalName} Remix`, identityScope),
    badRequests,
  );
  const ordinary = [
    ...tagAlbums(latest.page.items, "latest-release", true),
    ...tagAlbums(artistAlbums.page.items, "artist-albums", true),
    ...tagAlbums(singles.page.items, "singles", true),
    ...tagAlbums(fullAlbums.page.items, "full-albums", true),
  ];
  const remix = [
    ...tagAlbums(appears.page.items, "appears-on-albums", false),
    ...tagAlbums(search.page.albums, "catalog-search-album", false),
    ...search.page.songs.map((song) => ({ song, source: "catalog-search-song" as const })),
  ];
  albums.push(
    ...latest.page.items,
    ...artistAlbums.page.items,
    ...singles.page.items,
    ...fullAlbums.page.items,
    ...appears.page.items,
    ...search.page.albums,
  );
  songs.push(...search.page.songs);
  const classify = (
    value:
      | { album: AppleMusicAlbum; confirmed: boolean; source: AppleMusicRecentSource }
      | { song: AppleMusicSong; source: AppleMusicRecentSource },
  ) =>
    classifyAppleMusicRecentCandidate({
      aliases: artist.aliases,
      ...("album" in value
        ? { album: value.album, confirmedArtistAssociation: value.confirmed }
        : { confirmedArtistAssociation: false, song: value.song }),
      source: value.source,
      watchedArtist: artist.canonicalName,
      window,
    });
  const armA = ordinary
    .filter((value) => ["latest-release", "artist-albums"].includes(value.source))
    .map(classify);
  const armB = ordinary
    .filter((value) => ["latest-release", "singles", "full-albums"].includes(value.source))
    .map(classify);
  const armC = remix.map(classify);
  return {
    albums: dedupeAlbums(albums),
    all: mergeAppleMusicRecentCandidates([...armA, ...armB, ...armC]),
    armA,
    armARequests: latest.requested + artistAlbums.requested,
    armB,
    armBRequests: singles.requested + fullAlbums.requested,
    armC,
    armCRequests: appears.requested + search.requested,
    songs: dedupeSongs(songs),
  };
}

function emptyAlbumPage(): {
  page: AppleMusicArtistViewPage;
  requested: 0;
  status: AppleMusicRecentAvailability;
} {
  return {
    page: { items: [], nextPresent: false },
    requested: 0,
    status: "available_empty",
  };
}

async function safePage(
  shape: string,
  request: () => Promise<AppleMusicArtistViewPage>,
  badRequests: Map<string, number>,
): Promise<{
  page: AppleMusicArtistViewPage;
  requested: number;
  status: AppleMusicRecentAvailability;
}> {
  try {
    const page = await request();
    return {
      page,
      requested: 1,
      status: page.items.length > 0 ? "available_with_results" : "available_empty",
    };
  } catch (error) {
    handleNonterminal(error, shape, badRequests);
    return {
      page: { items: [], nextPresent: false },
      requested: 1,
      status: errorStatus(error),
    };
  }
}

async function safeSongPage(
  shape: string,
  request: () => Promise<AppleMusicArtistSongViewPage>,
  badRequests: Map<string, number>,
): Promise<{
  page: AppleMusicArtistSongViewPage;
  requested: number;
  status: AppleMusicRecentAvailability;
}> {
  try {
    const page = await request();
    return {
      page,
      requested: 1,
      status: page.items.length > 0 ? "available_with_results" : "available_empty",
    };
  } catch (error) {
    handleNonterminal(error, shape, badRequests);
    return {
      page: { items: [], nextPresent: false },
      requested: 1,
      status: errorStatus(error),
    };
  }
}

async function safeSearch(
  request: () => Promise<AppleMusicRecentSearchPage>,
  badRequests: Map<string, number>,
): Promise<{
  page: AppleMusicRecentSearchPage;
  requested: number;
  status: AppleMusicRecentAvailability;
}> {
  try {
    const page = await request();
    return {
      page,
      requested: 1,
      status:
        page.albums.length + page.songs.length > 0 ? "available_with_results" : "available_empty",
    };
  } catch (error) {
    handleNonterminal(error, "catalog-remix-search", badRequests);
    return {
      page: {
        albums: [],
        albumsNextPresent: false,
        songs: [],
        songsNextPresent: false,
      },
      requested: 1,
      status: errorStatus(error),
    };
  }
}

function errorStatus(error: unknown): AppleMusicRecentAvailability {
  return error instanceof AppleMusicClientError && error.status === 404
    ? "unavailable_404"
    : "failed";
}

function handleNonterminal(error: unknown, shape: string, badRequests: Map<string, number>): void {
  if (!(error instanceof AppleMusicClientError)) throw error;
  if ([401, 403, 429].includes(error.status ?? 0)) throw error;
  if (error.status === 400) {
    const count = (badRequests.get(shape) ?? 0) + 1;
    badRequests.set(shape, count);
    if (count >= 2) throw new Error(`systematic_http_400:${shape}`);
    return;
  }
  if (error.status === 404 || (error.status ?? 0) >= 500) return;
  throw error;
}

function tagAlbums(values: AppleMusicAlbum[], source: AppleMusicRecentSource, confirmed: boolean) {
  return values.map((album) => ({ album, confirmed, source }));
}

function publicGroundTruth(values: ItunesPilotGroundTruthRelease[]) {
  return values.map((release) => ({
    date: release.releaseDate,
    title: release.title,
    type: release.releaseType,
  }));
}

function snapshotArtist(snapshot: ItunesPilotSnapshot, canonicalArtistId: string) {
  const artist = snapshot.artists.find(
    (candidate) => candidate.canonicalArtistId === canonicalArtistId,
  );
  if (!artist) throw new Error("A recent sample artist is absent from the snapshot.");
  return artist;
}

function dedupeAlbums(values: AppleMusicAlbum[]): AppleMusicAlbum[] {
  return [...new Map(values.map((album) => [album.albumId, album])).values()];
}

function dedupeSongs(values: AppleMusicSong[]): AppleMusicSong[] {
  return [...new Map(values.map((song) => [song.songId, song])).values()];
}

function classifyTerminal(error: unknown): {
  reason: string;
  status: "controlled_partial" | "failed";
} {
  if (error instanceof AppleMusicClientError) {
    return {
      reason:
        error.status === 401
          ? "authentication_http_401"
          : error.status === 403
            ? "authentication_http_403"
            : error.status === 429
              ? "provider_http_429"
              : error.classification.slice(0, 100),
      status:
        [401, 403, 429].includes(error.status ?? 0) || error.classification.includes("budget")
          ? "controlled_partial"
          : "failed",
    };
  }
  if (error instanceof Error && error.message.startsWith("systematic_http_400:")) {
    return { reason: "systematic_endpoint_http_400", status: "controlled_partial" };
  }
  return { reason: "unexpected_failure", status: "failed" };
}

function assertAuthorization(value: AppleMusicRecentAuthorization): void {
  const requiredConfirmation =
    value.scope === "validation_25"
      ? appleMusicRecentValidationConfirmation
      : value.scope === "seed_discovery_5"
        ? appleMusicRecentSeedDiscoveryConfirmation
        : appleMusicRecentConfirmation;
  if (
    value[authorizationMarker] !== true ||
    value.confirmation !== requiredConfirmation ||
    value.evaluationAsOf !== appleMusicRecentEvaluationTime ||
    value.persistentProviderEnabled !== false ||
    value.storefront !== "us"
  ) {
    throw new Error("A valid command-scoped Apple recent authorization is required.");
  }
}
