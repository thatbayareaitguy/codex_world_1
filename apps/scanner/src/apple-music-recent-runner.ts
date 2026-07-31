import {
  decideAppleMusicArtistMapping,
  normalizeText,
  type AppleMusicMappingDecision,
} from "@radar/core";
import {
  AppleMusicClientError,
  type AppleMusicAlbum,
  type AppleMusicArtist,
  type AppleMusicArtistView,
  type AppleMusicArtistViewPage,
  type AppleMusicRecentSearchPage,
  type AppleMusicSong,
} from "@radar/providers";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import type { AppleMusicPilotPlanArtist } from "./apple-music-pilot-definition";
import {
  appleMusicRecentConfirmation,
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
  appleMusicRecentWindow,
  classifyAppleMusicRecentCandidate,
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

const authorizationMarker = Symbol("apple-music-recent-authorization");

export interface AppleMusicRecentAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation: typeof appleMusicRecentConfirmation;
  readonly evaluationAsOf: typeof appleMusicRecentEvaluationTime;
  readonly persistentProviderEnabled: false;
  readonly storefront: "us";
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
  searchArtists(term: string): Promise<AppleMusicArtist[]>;
  searchRecentRemixes(term: string, identityScope: string): Promise<AppleMusicRecentSearchPage>;
}

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
      classification: AppleMusicRecentCandidate["classification"];
      comparisonStatus: string;
      eligible: boolean;
      releaseDate?: string;
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

export function authorizeAppleMusicRecent(input: {
  confirmation?: string;
  evaluationAsOf?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
}): AppleMusicRecentAuthorization {
  if (!input.executeLive) throw new Error("Live Apple recent execution requires --execute-live.");
  if (input.confirmation !== appleMusicRecentConfirmation) {
    throw new Error(`Live execution requires --confirm-live ${appleMusicRecentConfirmation}.`);
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
    confirmation: appleMusicRecentConfirmation,
    evaluationAsOf: appleMusicRecentEvaluationTime,
    persistentProviderEnabled: false as const,
    storefront: "us" as const,
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
        entry.knownAppleArtistId,
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
        comparisonStatus: candidateComparison(candidate, groundTruth),
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
          classification: candidate.classification,
          comparisonStatus: candidate.comparisonStatus,
          eligible: candidate.eligible,
          ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {}),
          sources: candidate.sources,
          title: candidate.albumTitle,
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

async function resolveMapping(
  client: AppleMusicRecentClient,
  store: AppleMusicRecentStore,
  snapshotId: string,
  artist: ItunesPilotSnapshotArtist,
  knownId?: string,
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
  return decideAppleMusicArtistMapping({
    aliases: artist.aliases,
    canonicalName: artist.canonicalName,
    searchCandidates: await client.searchArtists(artist.canonicalName),
  });
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

async function safePage(
  shape: string,
  request: () => Promise<AppleMusicArtistViewPage>,
  badRequests: Map<string, number>,
): Promise<{ page: AppleMusicArtistViewPage; requested: number }> {
  try {
    return { page: await request(), requested: 1 };
  } catch (error) {
    handleNonterminal(error, shape, badRequests);
    return { page: { items: [], nextPresent: false }, requested: 1 };
  }
}

async function safeSearch(
  request: () => Promise<AppleMusicRecentSearchPage>,
  badRequests: Map<string, number>,
): Promise<{ page: AppleMusicRecentSearchPage; requested: number }> {
  try {
    return { page: await request(), requested: 1 };
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
    };
  }
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

function candidateComparison(
  candidate: AppleMusicRecentCandidate,
  groundTruth: ItunesPilotGroundTruthRelease[],
): string {
  if (!candidate.eligible) return "excluded";
  const candidateTitle = comparableTitle(candidate.albumTitle);
  const sameTitle = groundTruth.filter(
    (release) => comparableTitle(release.title) === candidateTitle,
  );
  if (sameTitle.some((release) => release.releaseDate === candidate.releaseDate)) {
    return "exact_match";
  }
  if (
    sameTitle.some(
      (release) =>
        candidate.releaseDate &&
        Math.abs(Date.parse(release.releaseDate) - Date.parse(candidate.releaseDate)) <= 86_400_000,
    )
  ) {
    return "strong_probable_match";
  }
  return sameTitle.length > 0 ? "ambiguous_match" : "apple_only_candidate";
}

function comparableTitle(value: string): string {
  return normalizeText(value)
    .replace(/\s+(?:single|ep)$/u, "")
    .trim();
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
  if (
    value[authorizationMarker] !== true ||
    value.confirmation !== appleMusicRecentConfirmation ||
    value.evaluationAsOf !== appleMusicRecentEvaluationTime ||
    value.persistentProviderEnabled !== false ||
    value.storefront !== "us"
  ) {
    throw new Error("A valid command-scoped Apple recent authorization is required.");
  }
}
