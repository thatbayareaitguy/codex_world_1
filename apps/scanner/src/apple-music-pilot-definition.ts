import { appleMusicArtistViews, type AppleMusicArtistView } from "@radar/providers";
import manifest from "./apple-music-pilot-manifest.json";
import {
  readItunesPilotSnapshot,
  type ItunesPilotSnapshot,
  type ItunesPilotSnapshotArtist,
} from "./itunes-pilot-snapshot";

export const appleMusicLiveConfirmation = "APPLE_PUBLIC_CATALOG_25";

export interface AppleMusicPilotDefinition {
  authenticationArtist: string;
  canaryArtists: string[];
  cohort: {
    identityCatalogStressArtists: string[];
    identityFailures: string[];
    positiveReleaseArtists: string[];
  };
  knownArtistIds: Record<string, string>;
  limits: {
    canaryRequestBudget: number;
    canaryRuntimeMs: number;
    concurrency: 1;
    minRequestIntervalMs: number;
    requestBudget: number;
    runtimeMs: number;
  };
  snapshot: {
    artistCount: number;
    identityStressArtistCount: number;
    negativeArtistCount: number;
    positiveArtistCount: number;
    releaseArtistCount: number;
    releaseCount: number;
    sha256: string;
    windowEnd: string;
    windowStart: string;
  };
  storefront: "us";
  version: 1;
}

export interface AppleMusicPilotForecast {
  albumDetailRequests: number;
  artistBatchRequests: number;
  authenticationProbeRequests: number;
  directViewRequests: number;
  expectedPaginationRequests: number;
  failedKnownIdSearches: number;
  fitsBudget: boolean;
  knownIdValidationRequests: number;
  requestBudget: number;
  retryReserve: number;
  searchRequests: number;
  totalRequests: number;
  trackRequests: number;
}

export interface AppleMusicPilotPlanArtist {
  canonicalArtistId: string;
  category: "identity_failure" | "positive_release" | "identity_catalog_stress";
  knownAppleArtistId?: string;
  name: string;
  requiresSearch: boolean;
}

export interface AppleMusicPilotPlan {
  allowedHost: "api.music.apple.com";
  allowedPathPrefix: "/v1/catalog/us/";
  artists: AppleMusicPilotPlanArtist[];
  authenticationArtist: "BUNT.";
  canaryArtists: string[];
  canaryForecast: AppleMusicPilotForecast;
  directViews: AppleMusicArtistView[];
  excludedOperations: string[];
  fullForecast: AppleMusicPilotForecast;
  knownArtistIds: Record<string, string>;
  limits: AppleMusicPilotDefinition["limits"];
  mode: "plan";
  musicUserTokenRequired: false;
  networkRequestsStarted: 0;
  operations: string[];
  snapshot: {
    artistCount: number;
    releaseArtistCount: number;
    releaseCount: number;
    sha256: string;
    windowEnd: string;
    windowStart: string;
  };
  storefront: "us";
  writes: {
    albums: 0;
    cache: 0;
    comparisons: 0;
    leases: 0;
    mappings: 0;
    requestTelemetry: 0;
    runs: 0;
    songs: 0;
  };
}

export const appleMusicPilotDefinition = manifest as AppleMusicPilotDefinition;

export async function createAppleMusicPilotPlan(
  snapshotPath: string,
  readSnapshot: (path: string) => Promise<ItunesPilotSnapshot> = readItunesPilotSnapshot,
): Promise<AppleMusicPilotPlan> {
  const snapshot = await readSnapshot(snapshotPath);
  const artists = validateAppleMusicPilotSnapshot(snapshot);
  const fullForecast = forecastAppleMusicPilotRequests("full");
  const canaryForecast = forecastAppleMusicPilotRequests("canary");
  if (!fullForecast.fitsBudget || !canaryForecast.fitsBudget) {
    throw new Error("The conservative Apple Music request forecast exceeds a pilot budget.");
  }
  return {
    allowedHost: "api.music.apple.com",
    allowedPathPrefix: "/v1/catalog/us/",
    artists,
    authenticationArtist: "BUNT.",
    canaryArtists: [...appleMusicPilotDefinition.canaryArtists],
    canaryForecast,
    directViews: [...appleMusicArtistViews],
    excludedOperations: [
      "Music User Tokens",
      "/v1/me",
      "personal libraries",
      "artwork",
      "previews",
      "playback",
      "Apple playlists",
      "Apple Music Feed",
      "Spotify",
      "free iTunes",
      "other providers",
      "production scanner",
      "scheduler",
      "feed mutation",
    ],
    fullForecast,
    knownArtistIds: { ...appleMusicPilotDefinition.knownArtistIds },
    limits: { ...appleMusicPilotDefinition.limits },
    mode: "plan",
    musicUserTokenRequired: false,
    networkRequestsStarted: 0,
    operations: [
      "validate three known public artist IDs",
      "search individually for artists without a confirmed ID",
      "run the five-artist canary",
      "batch confirmed artist IDs only after resolution",
      "fetch six direct views for each confirmed artist",
      "follow validated same-host pagination to terminal",
      "retrieve album details and tracks only when matching or appearance evidence requires them",
      "compare normalized Apple catalog evidence with the immutable frozen snapshot",
    ],
    snapshot: {
      artistCount: snapshot.artists.length,
      releaseArtistCount: new Set(
        snapshot.groundTruthReleases.map((release) => release.canonicalArtistId),
      ).size,
      releaseCount: snapshot.groundTruthReleases.length,
      sha256: snapshot.snapshotHash,
      windowEnd: snapshot.windowEnd,
      windowStart: snapshot.windowStart,
    },
    storefront: "us",
    writes: {
      albums: 0,
      cache: 0,
      comparisons: 0,
      leases: 0,
      mappings: 0,
      requestTelemetry: 0,
      runs: 0,
      songs: 0,
    },
  };
}

export function validateAppleMusicPilotSnapshot(
  snapshot: ItunesPilotSnapshot,
  definition: AppleMusicPilotDefinition = appleMusicPilotDefinition,
): AppleMusicPilotPlanArtist[] {
  validateDefinition(definition);
  if (snapshot.snapshotHash !== definition.snapshot.sha256) {
    throw new Error("The Apple pilot snapshot hash does not match the pinned snapshot.");
  }
  const counts = {
    identityStress: snapshot.artists.filter((artist) => artist.cohortReason === "identity_stress")
      .length,
    negative: snapshot.artists.filter((artist) => artist.cohortReason === "negative").length,
    positive: snapshot.artists.filter((artist) => artist.cohortReason === "positive").length,
  };
  const releaseArtistCount = new Set(
    snapshot.groundTruthReleases.map((release) => release.canonicalArtistId),
  ).size;
  if (
    snapshot.artists.length !== definition.snapshot.artistCount ||
    counts.positive !== definition.snapshot.positiveArtistCount ||
    counts.negative !== definition.snapshot.negativeArtistCount ||
    counts.identityStress !== definition.snapshot.identityStressArtistCount ||
    snapshot.windowStart !== definition.snapshot.windowStart ||
    snapshot.windowEnd !== definition.snapshot.windowEnd ||
    snapshot.groundTruthReleases.length !== definition.snapshot.releaseCount ||
    releaseArtistCount !== definition.snapshot.releaseArtistCount
  ) {
    throw new Error("The Apple pilot snapshot properties differ from the pinned definition.");
  }
  const byName = new Map<string, ItunesPilotSnapshotArtist[]>();
  for (const artist of snapshot.artists) {
    const matches = byName.get(artist.canonicalName) ?? [];
    matches.push(artist);
    byName.set(artist.canonicalName, matches);
  }
  return cohortEntries(definition).map(({ category, name }) => {
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) {
      throw new Error(`Pinned Apple pilot artist ${name} must appear exactly once.`);
    }
    const knownAppleArtistId = definition.knownArtistIds[name];
    return {
      canonicalArtistId: matches[0]!.canonicalArtistId,
      category,
      ...(knownAppleArtistId ? { knownAppleArtistId } : {}),
      name,
      requiresSearch: !knownAppleArtistId,
    };
  });
}

export function forecastAppleMusicPilotRequests(phase: "canary" | "full"): AppleMusicPilotForecast {
  if (phase === "canary") {
    const forecast = {
      albumDetailRequests: 4,
      artistBatchRequests: 0,
      authenticationProbeRequests: 1,
      directViewRequests: 5 * appleMusicArtistViews.length,
      expectedPaginationRequests: 6,
      failedKnownIdSearches: 1,
      knownIdValidationRequests: 1,
      requestBudget: appleMusicPilotDefinition.limits.canaryRequestBudget,
      retryReserve: 5,
      searchRequests: 3,
      trackRequests: 4,
    };
    return withForecastTotal(forecast);
  }
  const forecast = {
    albumDetailRequests: 8,
    artistBatchRequests: 1,
    authenticationProbeRequests: 1,
    directViewRequests: 25 * appleMusicArtistViews.length,
    expectedPaginationRequests: 12,
    failedKnownIdSearches: 3,
    knownIdValidationRequests: 2,
    requestBudget: appleMusicPilotDefinition.limits.requestBudget,
    retryReserve: 10,
    searchRequests: 22,
    trackRequests: 8,
  };
  return withForecastTotal(forecast);
}

export function formatAppleMusicPilotPlan(plan: AppleMusicPilotPlan): string {
  const known = Object.entries(plan.knownArtistIds)
    .map(([name, id]) => `  - ${name}: ${id}`)
    .join("\n");
  const searches = plan.artists
    .filter((artist) => artist.requiresSearch)
    .map((artist) => artist.name)
    .join(", ");
  return [
    "Apple Music public-catalog pilot plan",
    `Snapshot: ${plan.snapshot.sha256}`,
    `Cohort: ${plan.artists.length} unique artists`,
    `Storefront: ${plan.storefront}`,
    `Allowed network boundary: https://${plan.allowedHost}${plan.allowedPathPrefix}...`,
    `Direct views: ${plan.directViews.join(", ")}`,
    "Known public artist IDs:",
    known,
    `Artists requiring evidence-safe search: ${searches}`,
    `Authentication probe: ${plan.authenticationArtist}`,
    `Canary: ${plan.canaryArtists.join(", ")}`,
    `Canary forecast: ${plan.canaryForecast.totalRequests}/${plan.canaryForecast.requestBudget} requests`,
    `Full forecast: ${plan.fullForecast.totalRequests}/${plan.fullForecast.requestBudget} requests`,
    `Limits: ${plan.limits.runtimeMs / 60_000} minutes, concurrency ${plan.limits.concurrency}, ${plan.limits.minRequestIntervalMs} ms minimum interval`,
    "Plan effects: 0 network requests and 0 database writes",
    `Excluded: ${plan.excludedOperations.join(", ")}`,
  ].join("\n");
}

export function assertSanitizedAppleMusicPilotEvidence(value: unknown): void {
  const prohibited = findProhibitedEvidenceKey(value);
  if (prohibited) {
    throw new Error(`Apple pilot evidence contains prohibited field ${prohibited}.`);
  }
}

function validateDefinition(definition: AppleMusicPilotDefinition): void {
  const cohort = cohortEntries(definition);
  const names = cohort.map((entry) => entry.name);
  if (names.length !== 25)
    throw new Error("The pinned Apple pilot cohort must contain 25 artists.");
  if (new Set(names).size !== names.length) {
    throw new Error("The pinned Apple pilot cohort contains a duplicate artist.");
  }
  if (
    !names.includes(definition.authenticationArtist) ||
    definition.canaryArtists.length !== 5 ||
    new Set(definition.canaryArtists).size !== 5 ||
    definition.canaryArtists.some((name) => !names.includes(name))
  ) {
    throw new Error("The pinned Apple pilot authentication or canary selection is invalid.");
  }
  if (
    definition.storefront !== "us" ||
    definition.limits.requestBudget !== 225 ||
    definition.limits.runtimeMs !== 45 * 60_000 ||
    definition.limits.canaryRequestBudget !== 75 ||
    definition.limits.canaryRuntimeMs !== 15 * 60_000 ||
    definition.limits.concurrency !== 1 ||
    definition.limits.minRequestIntervalMs < 1_100
  ) {
    throw new Error("The pinned Apple pilot safety limits are invalid.");
  }
  for (const [name, id] of Object.entries(definition.knownArtistIds)) {
    if (!names.includes(name) || !/^\d+$/.test(id)) {
      throw new Error("The pinned Apple pilot known-ID definition is invalid.");
    }
  }
}

function cohortEntries(definition: AppleMusicPilotDefinition): AppleMusicPilotPlanArtist[] {
  return [
    ...definition.cohort.identityFailures.map((name) => ({
      canonicalArtistId: "",
      category: "identity_failure" as const,
      name,
      requiresSearch: true,
    })),
    ...definition.cohort.positiveReleaseArtists.map((name) => ({
      canonicalArtistId: "",
      category: "positive_release" as const,
      name,
      requiresSearch: true,
    })),
    ...definition.cohort.identityCatalogStressArtists.map((name) => ({
      canonicalArtistId: "",
      category: "identity_catalog_stress" as const,
      name,
      requiresSearch: true,
    })),
  ];
}

function withForecastTotal(
  forecast: Omit<AppleMusicPilotForecast, "fitsBudget" | "totalRequests">,
): AppleMusicPilotForecast {
  const totalRequests =
    forecast.albumDetailRequests +
    forecast.artistBatchRequests +
    forecast.authenticationProbeRequests +
    forecast.directViewRequests +
    forecast.expectedPaginationRequests +
    forecast.failedKnownIdSearches +
    forecast.knownIdValidationRequests +
    forecast.retryReserve +
    forecast.searchRequests +
    forecast.trackRequests;
  return { ...forecast, fitsBudget: totalRequests <= forecast.requestBudget, totalRequests };
}

function findProhibitedEvidenceKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findProhibitedEvidenceKey(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (
      /(^|_)(authorization|developer_token|team_id|key_id|media_id|private_key|private_key_path|raw_response|response_body|artwork|preview|preview_url|music_user_token)(_|$)/.test(
        normalized,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const result = findProhibitedEvidenceKey(child, path ? `${path}.${key}` : key);
    if (result) return result;
  }
  return undefined;
}
