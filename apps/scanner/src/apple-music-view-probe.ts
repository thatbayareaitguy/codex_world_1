import { AppleMusicGateError } from "@radar/db";
import {
  AppleMusicClientError,
  appleMusicArtistViewRequestShape,
  type AppleMusicArtistView,
  type AppleMusicArtistViewPage,
  type AppleMusicErrorDiagnostic,
} from "@radar/providers";
import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export const appleMusicViewProbeConfirmation = "APPLE_PUBLIC_CATALOG_VIEW_PROBE";
export const appleMusicViewProbeArtist = "NURKO";
export const appleMusicViewProbeView = "latest-release";

const authorizationMarker = Symbol("apple-music-view-probe-authorization");

export interface AppleMusicViewProbeAuthorization {
  readonly [authorizationMarker]: true;
  readonly artist: typeof appleMusicViewProbeArtist;
  readonly confirmation: typeof appleMusicViewProbeConfirmation;
  readonly mode: "bounded_public_catalog_view_probe";
  readonly persistentProviderEnabled: false;
  readonly storefront: "us";
  readonly view: typeof appleMusicViewProbeView;
}

export interface AppleMusicViewProbeStore {
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
  operationalStatus(): Promise<{ cooldownActive: boolean; leaseActive: boolean }>;
  readEvidence(runId: string): Promise<AppleMusicPilotStoredEvidence>;
  releaseLease(leaseToken: string): Promise<void>;
}

export interface AppleMusicViewProbeSummary {
  artist: typeof appleMusicViewProbeArtist;
  cacheHits: number;
  error?: AppleMusicErrorDiagnostic;
  httpStatus?: number;
  mappingConfirmed: boolean;
  mode: "artist_view_probe";
  nextPresent: boolean;
  paginationFollowed: false;
  requestCount: number;
  requestShape: ReturnType<typeof appleMusicArtistViewRequestShape>;
  resourcesReturned: number;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
  view: typeof appleMusicViewProbeView;
}

export function authorizeAppleMusicViewProbe(input: {
  artist: string;
  confirmation?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
  view: string;
}): AppleMusicViewProbeAuthorization {
  if (!input.executeLive) throw new Error("Apple Music view probe requires --execute-live.");
  if (input.confirmation !== appleMusicViewProbeConfirmation) {
    throw new Error(
      `Apple Music view probe requires --confirm-live ${appleMusicViewProbeConfirmation}.`,
    );
  }
  if (input.artist !== appleMusicViewProbeArtist) {
    throw new Error(`Apple Music view probe permits only ${appleMusicViewProbeArtist}.`);
  }
  if (input.view !== appleMusicViewProbeView) {
    throw new Error(`Apple Music view probe permits only ${appleMusicViewProbeView}.`);
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) {
    throw new Error("Every non-Apple provider must be disabled for the Apple view probe.");
  }
  if (input.storefront !== "us")
    throw new Error("The Apple view probe requires the US storefront.");
  return Object.freeze({
    [authorizationMarker]: true as const,
    artist: appleMusicViewProbeArtist,
    confirmation: appleMusicViewProbeConfirmation,
    mode: "bounded_public_catalog_view_probe" as const,
    persistentProviderEnabled: false as const,
    storefront: "us" as const,
    view: appleMusicViewProbeView,
  });
}

export async function runBoundedAppleMusicViewProbe(input: {
  authorization: AppleMusicViewProbeAuthorization;
  createClient(
    runId: string,
    leaseToken: string,
  ): {
    getArtistViewFirstPage(
      artistId: string,
      view: AppleMusicArtistView,
    ): Promise<AppleMusicArtistViewPage>;
  };
  implementationCommit: string;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicViewProbeStore;
}): Promise<AppleMusicViewProbeSummary> {
  assertAuthorization(input.authorization);
  const cohort = validateAppleMusicPilotSnapshot(input.snapshot);
  const entry = cohort.find((artist) => artist.name === appleMusicViewProbeArtist);
  if (!entry) throw new Error("The pinned Apple view-probe artist is missing.");
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) {
    throw new AppleMusicGateError(
      "Apple Music requests are blocked by a persisted cooldown.",
      "provider_cooldown",
    );
  }
  if (operational.leaseActive) {
    throw new AppleMusicGateError(
      "An Apple Music request lease is already active.",
      "run_inactive",
    );
  }
  const snapshotId = await input.store.importSnapshot(input.snapshot);
  const mapping = await input.store.findConfirmedMapping({
    canonicalArtistId: entry.canonicalArtistId,
    snapshotId,
  });
  const requestShape = appleMusicArtistViewRequestShape(appleMusicViewProbeView);
  if (!mapping) {
    return {
      artist: appleMusicViewProbeArtist,
      cacheHits: 0,
      mappingConfirmed: false,
      mode: "artist_view_probe",
      nextPresent: false,
      paginationFollowed: false,
      requestCount: 0,
      requestShape,
      resourcesReturned: 0,
      status: "controlled_partial",
      stopReason: "view_probe_mapping_missing",
      view: appleMusicViewProbeView,
    };
  }

  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: 5 * 60_000,
    minRequestIntervalMs: 1_100,
    requestBudget: 1,
    snapshotId,
  });
  let leaseToken: string | undefined;
  let errorDiagnostic: AppleMusicErrorDiagnostic | undefined;
  let nextPresent = false;
  let resourcesReturned = 0;
  let status: AppleMusicViewProbeSummary["status"] = "failed";
  let stopReason = "view_probe_unexpected_failure";
  let httpStatus: number | undefined;
  let evidence: AppleMusicPilotStoredEvidence = emptyEvidence();
  try {
    leaseToken = await input.store.claimLease(run.id);
    const page = await input
      .createClient(run.id, leaseToken)
      .getArtistViewFirstPage(mapping.appleArtistId, appleMusicViewProbeView);
    nextPresent = page.nextPresent;
    resourcesReturned = page.items.length;
    status = "completed";
    stopReason = "view_probe_completed";
  } catch (error) {
    if (error instanceof AppleMusicClientError) {
      httpStatus = error.status;
      errorDiagnostic = error.appleError;
      if ([400, 401, 403, 429].includes(error.status ?? 0)) {
        status = "controlled_partial";
        stopReason = `view_probe_http_${error.status}`;
      } else {
        status = "failed";
        stopReason = `view_probe_${error.classification}`.slice(0, 100);
      }
    } else if (error instanceof AppleMusicGateError) {
      status = "controlled_partial";
      stopReason = `view_probe_${error.classification}`;
    }
  } finally {
    try {
      evidence = await input.store.readEvidence(run.id);
      httpStatus ??= firstHttpStatus(evidence);
      if (evidence.requestCount !== 1) {
        status = "failed";
        stopReason = "view_probe_request_count_mismatch";
      }
      const summary = createSummary({
        cacheHits: evidence.cacheHits,
        ...(errorDiagnostic ? { error: errorDiagnostic } : {}),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        mappingConfirmed: true,
        nextPresent,
        requestCount: evidence.requestCount,
        requestShape,
        resourcesReturned,
        status,
        stopReason,
      });
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  return createSummary({
    cacheHits: evidence.cacheHits,
    ...(errorDiagnostic ? { error: errorDiagnostic } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    mappingConfirmed: true,
    nextPresent,
    requestCount: evidence.requestCount,
    requestShape,
    resourcesReturned,
    status,
    stopReason,
  });
}

function createSummary(input: {
  cacheHits: number;
  error?: AppleMusicErrorDiagnostic;
  httpStatus?: number;
  mappingConfirmed: boolean;
  nextPresent: boolean;
  requestCount: number;
  requestShape: ReturnType<typeof appleMusicArtistViewRequestShape>;
  resourcesReturned: number;
  status: AppleMusicViewProbeSummary["status"];
  stopReason: string;
}): AppleMusicViewProbeSummary {
  return {
    artist: appleMusicViewProbeArtist,
    cacheHits: input.cacheHits,
    ...(input.error ? { error: input.error } : {}),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    mappingConfirmed: input.mappingConfirmed,
    mode: "artist_view_probe",
    nextPresent: input.nextPresent,
    paginationFollowed: false,
    requestCount: input.requestCount,
    requestShape: input.requestShape,
    resourcesReturned: input.resourcesReturned,
    status: input.status,
    stopReason: input.stopReason,
    view: appleMusicViewProbeView,
  };
}

function firstHttpStatus(evidence: AppleMusicPilotStoredEvidence): number | undefined {
  const value = Object.keys(evidence.httpStatusCounts).find((key) => /^\d{3}$/.test(key));
  return value ? Number(value) : undefined;
}

function emptyEvidence(): AppleMusicPilotStoredEvidence {
  return {
    authenticationAttempts: 0,
    cacheHits: 0,
    endpointRequestCounts: {},
    httpStatusCounts: {},
    maximumConcurrency: 0,
    paginationRequests: 0,
    requestCount: 0,
    retryCount: 0,
  };
}

function assertAuthorization(authorization: AppleMusicViewProbeAuthorization): void {
  if (
    authorization[authorizationMarker] !== true ||
    authorization.confirmation !== appleMusicViewProbeConfirmation ||
    authorization.mode !== "bounded_public_catalog_view_probe" ||
    authorization.artist !== appleMusicViewProbeArtist ||
    authorization.view !== appleMusicViewProbeView ||
    authorization.persistentProviderEnabled !== false ||
    authorization.storefront !== "us"
  ) {
    throw new Error("A valid command-scoped Apple view-probe authorization is required.");
  }
}
