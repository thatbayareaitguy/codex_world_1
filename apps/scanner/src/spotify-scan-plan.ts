import {
  createSpotifyScanBatch,
  latestSpotifyBatch,
  recoverSpotifyBatch,
  releaseCandidates,
  releaseExternalIds,
  resumeSpotifyBatch,
  spotifyArtistScans,
  type RadarDatabase,
  type SpotifyScanMode,
} from "@radar/db";
import type { ProviderConfiguration, SpotifyArtistMapping } from "@radar/providers";
import { desc, eq, inArray } from "drizzle-orm";
import type { ScannerOptions } from "./args";

export interface PreparedSpotifyWork {
  batchId: string;
  knownReleaseIds: ReadonlySet<string>;
  mappings: SpotifyArtistMapping[];
  maxPagesPerArtist: number;
  mode: SpotifyScanMode;
  paused: boolean;
}

export async function prepareSpotifyWork(
  db: RadarDatabase,
  mappings: SpotifyArtistMapping[],
  configuration: ProviderConfiguration,
  options: ScannerOptions,
): Promise<PreparedSpotifyWork> {
  const knownReleaseIds = await loadKnownSpotifyReleaseIds(db);
  if (options.artistId) {
    const mapping = mappings.find((entry) => entry.artistId === options.artistId);
    if (!mapping) throw new Error("The requested artist has no confirmed Spotify mapping.");
    const mode = options.spotifyMode ?? "daily";
    const maxPagesPerArtist = pageLimit(configuration, mode, options.spotifyMaxPages);
    const batchId = await createSpotifyScanBatch(db, {
      artists: [{ artistId: mapping.artistId }],
      confirmationRequired: false,
      estimatedRequests: estimateRequests(1, maxPagesPerArtist),
      mode,
      pageLimit: maxPagesPerArtist,
    });
    return {
      batchId,
      knownReleaseIds,
      mappings: [mapping],
      maxPagesPerArtist,
      mode,
      paused: false,
    };
  }

  const latest = options.spotifyBatchId
    ? await loadBatch(db, options.spotifyBatchId)
    : await latestSpotifyBatch(db);
  if (latest && ["pending", "running", "paused", "rate_limited"].includes(latest.status)) {
    await recoverSpotifyBatch(db, latest.id);
    if (options.spotifyConfirmBatch) await resumeSpotifyBatch(db, latest.id);
    const selected = latest.artistScans
      .filter((progress) =>
        ["pending", "running", "paused", "rate_limited"].includes(progress.status),
      )
      .map((progress) => mappings.find((mapping) => mapping.artistId === progress.artistId))
      .filter((mapping): mapping is SpotifyArtistMapping => Boolean(mapping));
    return {
      batchId: latest.id,
      knownReleaseIds,
      mappings: selected,
      maxPagesPerArtist: latest.pageLimit,
      mode: latest.mode as SpotifyScanMode,
      paused: latest.status === "paused" && !options.spotifyConfirmBatch,
    };
  }

  const history = await db
    .select()
    .from(spotifyArtistScans)
    .where(inArray(spotifyArtistScans.status, ["completed", "partial"]))
    .orderBy(desc(spotifyArtistScans.finishedAt));
  const lastByArtist = new Map<string, (typeof history)[number]>();
  for (const row of history)
    if (!lastByArtist.has(row.artistId)) lastByArtist.set(row.artistId, row);
  const recentSpotifyCandidates = await db
    .select({
      artistExternalId: releaseCandidates.artistExternalId,
      releaseDate: releaseCandidates.releaseDate,
    })
    .from(releaseCandidates)
    .where(eq(releaseCandidates.provider, "spotify"));
  const recentCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const recentlyActiveSpotifyIds = new Set(
    recentSpotifyCandidates
      .filter((candidate) => candidate.releaseDate >= recentCutoff)
      .map((candidate) => candidate.artistExternalId),
  );
  const ordered = [...mappings].sort((left, right) => {
    const leftHistory = lastByArtist.get(left.artistId);
    const rightHistory = lastByArtist.get(right.artistId);
    const rank = (
      historyEntry: (typeof history)[number] | undefined,
      mapping: SpotifyArtistMapping,
    ) =>
      !historyEntry
        ? 0
        : recentlyActiveSpotifyIds.has(mapping.spotifyArtistId)
          ? 1
          : historyEntry.status === "partial"
            ? 2
            : 3;
    const leftRank = rank(leftHistory, left);
    const rightRank = rank(rightHistory, right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (leftHistory?.finishedAt?.getTime() ?? 0) - (rightHistory?.finishedAt?.getTime() ?? 0);
  });
  const selected = ordered.slice(0, configuration.spotify.artistsPerBatch);
  if (selected.length === 0) throw new Error("No active Spotify artist mappings are available.");
  const firstStagedBatch = history.length === 0;
  const mode = firstStagedBatch ? "initial" : (options.spotifyMode ?? "daily");
  const maxPagesPerArtist = pageLimit(configuration, mode, options.spotifyMaxPages);
  const batchId = await createSpotifyScanBatch(db, {
    artists: selected,
    confirmationRequired: firstStagedBatch,
    estimatedRequests: estimateRequests(selected.length, maxPagesPerArtist),
    mode,
    pageLimit: maxPagesPerArtist,
  });
  return {
    batchId,
    knownReleaseIds,
    mappings: selected,
    maxPagesPerArtist,
    mode,
    paused: firstStagedBatch,
  };
}

export function spotifyScheduleEstimate(
  artistCount: number,
  configuration: ProviderConfiguration,
): {
  artistsPerHour: number;
  estimatedMaximumRequests: number;
  estimatedMinimumHours: number;
  estimatedMaximumHours: number;
} {
  const artistsPerHour = artistCount / configuration.spotify.scanDistributionHours;
  const estimatedMaximumRequests = estimateRequests(
    artistCount,
    configuration.spotify.dailyMaxPagesPerArtist,
  );
  const requestHours =
    (estimatedMaximumRequests * configuration.spotify.minRequestIntervalMs) / 3_600_000;
  return {
    artistsPerHour,
    estimatedMaximumHours: Math.max(
      configuration.spotify.scanDistributionHours,
      requestHours * 1.5,
    ),
    estimatedMaximumRequests,
    estimatedMinimumHours: Math.max(configuration.spotify.scanDistributionHours, requestHours),
  };
}

function pageLimit(
  configuration: ProviderConfiguration,
  mode: SpotifyScanMode,
  override?: number,
): number {
  if (override) return override;
  if (mode === "initial") return configuration.spotify.initialMaxPagesPerArtist;
  if (mode === "reconciliation") return configuration.spotify.reconciliationMaxPagesPerArtist;
  return configuration.spotify.dailyMaxPagesPerArtist;
}

function estimateRequests(artists: number, pagesPerArtist: number): number {
  return artists * (pagesPerArtist + pagesPerArtist * 10);
}

async function loadKnownSpotifyReleaseIds(db: RadarDatabase): Promise<ReadonlySet<string>> {
  const [external, candidates] = await Promise.all([
    db
      .select({ id: releaseExternalIds.externalId })
      .from(releaseExternalIds)
      .where(eq(releaseExternalIds.provider, "spotify")),
    db
      .select({ id: releaseCandidates.providerReleaseId })
      .from(releaseCandidates)
      .where(eq(releaseCandidates.provider, "spotify")),
  ]);
  return new Set([...external, ...candidates].map((row) => row.id));
}

async function loadBatch(db: RadarDatabase, batchId: string) {
  const batch = await db.query.spotifyScanBatches.findFirst({
    where: (table, { eq }) => eq(table.id, batchId),
  });
  if (!batch) throw new Error("Spotify scan batch was not found.");
  const artistScans = await db.query.spotifyArtistScans.findMany({
    where: eq(spotifyArtistScans.batchId, batch.id),
    orderBy: (table, { asc }) => [asc(table.position)],
  });
  return { ...batch, artistScans };
}
