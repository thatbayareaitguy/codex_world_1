import {
  batchEquivalentToIndividuals,
  compareItunesToSpotify,
  decideItunesArtistMapping,
  dedupeItunesTracks,
  mergeItunesCollections,
  type ItunesCollectionCandidate,
  type ItunesTrackCandidate,
} from "@radar/core";
import {
  createItunesRequestPersistence,
  ItunesPilotGateError,
  itunesPilotMatches,
  itunesPilotRuns,
  type RadarDatabase,
} from "@radar/db";
import {
  ItunesClient,
  ItunesClientError,
  type ItunesCollection,
  type ItunesTrack,
  type ProviderConfiguration,
} from "@radar/providers";
import { eq } from "drizzle-orm";
import {
  finishItunesRun,
  pilotArtists,
  pilotGroundTruth,
  saveBatchExperiment,
  saveItunesCollections,
  saveItunesComparisons,
  saveItunesMapping,
  saveItunesTracks,
  startItunesRun,
  updateItunesRunMetrics,
} from "./itunes-pilot-repository";
import type { pilotEvaluationRows } from "./itunes-pilot-repository";

export async function runLiveItunesPilot(input: {
  configuration: ProviderConfiguration;
  db: RadarDatabase;
  runId: string;
}): Promise<{ status: string; stopReason: string }> {
  validateLiveConfiguration(input.configuration);
  const run = await startItunesRun(input.db, input.runId);
  const artists = await pilotArtists(input.db, run.snapshotId);
  if (artists.length !== 50) throw new Error("Live pilot requires exactly 50 snapshot artists.");
  const client = new ItunesClient({
    enabled: input.configuration.itunes.enabled,
    language: input.configuration.itunes.language,
    maxRequestsPerRun: input.configuration.itunes.maxRequestsPerRun,
    maxResponseBytes: input.configuration.itunes.maxResponseBytes,
    minRequestIntervalMs: input.configuration.itunes.minRequestIntervalMs,
    persistence: createItunesRequestPersistence(input.db),
    requestTimeoutMs: input.configuration.itunes.requestTimeoutMs,
    storefront: input.configuration.itunes.storefront,
  });
  const baselines = new Map<
    string,
    {
      appleArtistId: string;
      collections: ItunesCollectionCandidate[];
      tracks: ItunesTrackCandidate[];
    }
  >();
  const metrics = {
    deduplicatedCollections: 0,
    deduplicatedTracks: 0,
    rawCollectionObservations: 0,
    rawTrackObservations: 0,
  };
  try {
    for (const artist of artists) {
      const search = await client.searchArtists(run.id, artist.canonicalName);
      const decision = decideItunesArtistMapping({
        aliases: stringArray(artist.aliases),
        candidates: search.artists.map((candidate) => {
          const viewUrl = candidate.artistViewUrl ?? candidate.artistLinkUrl;
          return {
            artistId: candidate.artistId,
            artistName: candidate.artistName,
            ...(candidate.primaryGenreName ? { primaryGenreName: candidate.primaryGenreName } : {}),
            ...(viewUrl ? { viewUrl } : {}),
          };
        }),
        canonicalName: artist.canonicalName,
      });
      await saveItunesMapping(input.db, {
        candidates: search.artists,
        canonicalArtistId: artist.canonicalArtistId,
        decision,
        runId: run.id,
      });
      if (
        !decision.selected ||
        !["exact_confirmed", "evidence_confirmed"].includes(decision.status)
      ) {
        const groundTruth = await pilotGroundTruth(input.db, run.snapshotId, [
          artist.canonicalArtistId,
        ]);
        await saveItunesComparisons(input.db, {
          canonicalArtistId: artist.canonicalArtistId,
          comparisons: groundTruth.map((release) => ({
            classification: "identity_mapping_failure",
            reasons: [`Artist mapping ended as ${decision.status}.`],
            spotifyReleaseId: release.spotifyReleaseId,
          })),
          runId: run.id,
        });
        continue;
      }
      const [albums, songs] = await Promise.all([
        client.lookupAlbums(run.id, [decision.selected.artistId]),
        client.lookupSongs(run.id, [decision.selected.artistId]),
      ]);
      metrics.rawCollectionObservations +=
        albums.collections.length + songs.tracks.filter((track) => track.collectionId).length;
      metrics.rawTrackObservations += songs.tracks.length;
      const albumCollections = albums.collections.map(toCollectionCandidate);
      const songCollections = collectionsFromTracks(songs.tracks);
      const collections = mergeItunesCollections(albumCollections, songCollections);
      const tracks = dedupeItunesTracks(songs.tracks.map(toTrackCandidate));
      metrics.deduplicatedCollections +=
        albumCollections.length + songCollections.length - collections.length;
      metrics.deduplicatedTracks += songs.tracks.length - tracks.length;
      await saveItunesCollections(input.db, {
        canonicalArtistId: artist.canonicalArtistId,
        collections,
        runId: run.id,
      });
      await saveItunesTracks(input.db, {
        canonicalArtistId: artist.canonicalArtistId,
        mappedArtistId: decision.selected.artistId,
        runId: run.id,
        tracks,
      });
      const groundTruth = await pilotGroundTruth(input.db, run.snapshotId, [
        artist.canonicalArtistId,
      ]);
      const comparisons = compareItunesToSpotify(
        groundTruth.map((release) => ({
          canonicalReleaseId: release.canonicalReleaseId,
          normalizedTitle: release.normalizedTitle,
          releaseDate: release.releaseDate,
          releaseType: release.releaseType,
          spotifyReleaseId: release.spotifyReleaseId,
          title: release.title,
          ...(release.trackCount === null ? {} : { trackCount: release.trackCount }),
          ...(release.version ? { version: release.version } : {}),
        })),
        collections,
      );
      await saveItunesComparisons(input.db, {
        canonicalArtistId: artist.canonicalArtistId,
        comparisons,
        runId: run.id,
      });
      baselines.set(artist.canonicalArtistId, {
        appleArtistId: decision.selected.artistId,
        collections,
        tracks,
      });
    }
    await runBatchExperiments(input.db, client, run.id, baselines);
    await runCollectionDetailResolution(input.db, client, run.id, baselines);
    await updateItunesRunMetrics(input.db, run.id, metrics);
    await finishItunesRun(input.db, run.id, {
      status: "completed",
      stopReason: "pilot_workflow_completed",
    });
    return { status: "completed", stopReason: "pilot_workflow_completed" };
  } catch (error) {
    await updateItunesRunMetrics(input.db, run.id, metrics);
    const controlled =
      error instanceof ItunesPilotGateError ||
      (error instanceof ItunesClientError && error.status === 429);
    const stopReason =
      error instanceof ItunesPilotGateError
        ? error.classification
        : error instanceof ItunesClientError
          ? error.classification
          : "data_integrity_failure";
    await finishItunesRun(input.db, run.id, {
      status: controlled ? "controlled_partial" : "failed",
      stopReason,
    });
    if (!controlled) throw error;
    return { status: "controlled_partial", stopReason };
  }
}

async function runBatchExperiments(
  db: RadarDatabase,
  client: ItunesClient,
  runId: string,
  baselines: Map<
    string,
    {
      appleArtistId: string;
      collections: ItunesCollectionCandidate[];
      tracks: ItunesTrackCandidate[];
    }
  >,
) {
  const selected = [...baselines.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 10);
  for (const batchSize of [5, 10]) {
    const subset = selected.slice(0, batchSize);
    if (subset.length !== batchSize) continue;
    const appleArtistIds = subset.map(([, value]) => value.appleArtistId);
    const expectedCollections = subset.flatMap(([, value]) => value.collections);
    const expectedTracks = subset.flatMap(([, value]) => value.tracks);
    const albumBatch = await client.lookupAlbums(runId, appleArtistIds);
    const batchCollections = albumBatch.collections.map(toCollectionCandidate);
    const albumResult = batchEquivalentToIndividuals({
      batchCollections,
      batchTracks: [],
      expectedArtistIds: appleArtistIds,
      individualCollections: expectedCollections,
      individualTracks: [],
    });
    await saveBatchExperiment(db, {
      artistIds: appleArtistIds,
      batchResultCount: batchCollections.length,
      batchSize,
      entity: "album",
      individualResultCount: expectedCollections.length,
      reasons: albumResult.reasons,
      runId,
      safe: albumResult.safe,
    });
    const songBatch = await client.lookupSongs(runId, appleArtistIds);
    const batchTracks = songBatch.tracks.map(toTrackCandidate);
    const songResult = batchEquivalentToIndividuals({
      batchCollections: [],
      batchTracks,
      expectedArtistIds: appleArtistIds,
      individualCollections: [],
      individualTracks: expectedTracks,
    });
    await saveBatchExperiment(db, {
      artistIds: appleArtistIds,
      batchResultCount: batchTracks.length,
      batchSize,
      entity: "song",
      individualResultCount: expectedTracks.length,
      reasons: songResult.reasons,
      runId,
      safe: songResult.safe,
    });
  }
}

async function runCollectionDetailResolution(
  db: RadarDatabase,
  client: ItunesClient,
  runId: string,
  baselines: Map<
    string,
    {
      appleArtistId: string;
      collections: ItunesCollectionCandidate[];
      tracks: ItunesTrackCandidate[];
    }
  >,
) {
  const ambiguous = await db
    .select()
    .from(itunesPilotMatches)
    .where(eq(itunesPilotMatches.runId, runId));
  const targets = [
    ...new Map(
      ambiguous
        .filter((match) => match.classification === "ambiguous_match" && match.appleCollectionId)
        .map((match) => [match.appleCollectionId!, match]),
    ).values(),
  ];
  for (const target of targets) {
    const current = await db.query.itunesPilotRuns.findFirst({
      where: eq(itunesPilotRuns.id, runId),
      columns: { requestBudget: true, requestCount: true },
    });
    if (!current || current.requestCount >= current.requestBudget) return;
    const detail = await client.lookupCollectionSongs(runId, target.appleCollectionId!);
    const baseline = baselines.get(target.canonicalArtistId);
    if (!baseline) continue;
    await saveItunesTracks(db, {
      canonicalArtistId: target.canonicalArtistId,
      mappedArtistId: baseline.appleArtistId,
      runId,
      tracks: detail.tracks.map(toTrackCandidate),
    });
  }
}

export function buildItunesEvaluationMarkdown(
  rows: Awaited<ReturnType<typeof pilotEvaluationRows>>,
): string {
  const realRequests = rows.requests.filter((request) => !request.cacheHit);
  const cacheHits = rows.requests.length - realRequests.length;
  const mappingCount = (status: string) =>
    rows.mappings.filter((mapping) => mapping.status === status).length;
  const confirmedMappings = mappingCount("exact_confirmed") + mappingCount("evidence_confirmed");
  const matched = rows.matches.filter((match) =>
    ["exact_match", "strong_probable_match"].includes(match.classification),
  );
  const matchedSpotify = new Set(matched.map((match) => match.spotifyReleaseId).filter(Boolean));
  const positiveArtistIds = new Set(rows.releases.map((release) => release.canonicalArtistId));
  const discoveredPositiveArtists = new Set(matched.map((match) => match.canonicalArtistId));
  const mappingRate = ratio(confirmedMappings, rows.artists.length);
  const artistRecall = ratio(discoveredPositiveArtists.size, positiveArtistIds.size);
  const releaseRecall = ratio(matchedSpotify.size, rows.releases.length);
  const matchedApple = new Set(matched.map((match) => match.appleCollectionId).filter(Boolean));
  const precisionProxy = ratio(matchedApple.size, rows.collections.length);
  const minimumInterval = minimumRequestInterval(realRequests.map((request) => request.startedAt));
  const runtimeMs =
    rows.run.startedAt && rows.run.completedAt
      ? rows.run.completedAt.getTime() - rows.run.startedAt.getTime()
      : 0;
  const requestsByCategory = new Map<string, number>();
  for (const request of realRequests) {
    requestsByCategory.set(
      request.endpointCategory,
      (requestsByCategory.get(request.endpointCategory) ?? 0) + 1,
    );
  }
  const candidatesByWindow = (days: number) =>
    rows.collections.filter(
      (collection) =>
        rows.snapshot.snapshotTimestamp.getTime() - collection.releaseDate.getTime() >= 0 &&
        rows.snapshot.snapshotTimestamp.getTime() - collection.releaseDate.getTime() <=
          days * 86_400_000,
    ).length;
  const recallByWindow = (days: number) => {
    const cutoff = rows.snapshot.snapshotTimestamp.getTime() - days * 86_400_000;
    const eligible = rows.releases.filter((release) => Date.parse(release.releaseDate) >= cutoff);
    const ids = new Set(eligible.map((release) => release.spotifyReleaseId));
    return ratio(
      matched.filter((match) => match.spotifyReleaseId && ids.has(match.spotifyReleaseId)).length,
      ids.size,
    );
  };
  const safeBatches = rows.batches.filter((batch) => batch.safe);
  const safeBatchSize =
    safeBatches.length > 0 &&
    ["album", "song"].every((entity) => safeBatches.some((batch) => batch.entity === entity))
      ? Math.min(
          ...["album", "song"].map((entity) =>
            Math.max(
              ...safeBatches
                .filter((batch) => batch.entity === entity)
                .map((batch) => batch.batchSize),
            ),
          ),
        )
      : 0;
  const fullIndividualRequests = 593 * 2;
  const fullBatchRequests = safeBatchSize ? Math.ceil(593 / safeBatchSize) * 2 : null;
  const candidateArtistRate = ratio(
    new Set(rows.collections.map((collection) => collection.canonicalArtistId)).size,
    Math.max(1, confirmedMappings),
  );
  const projectedCandidateArtists = Math.round(593 * candidateArtistRate);
  const projectedSpotifyReduction = 593 - projectedCandidateArtists;
  const recommendation =
    mappingRate >= 0.9 && releaseRecall >= 0.8
      ? "Strong candidate for primary discovery sweep"
      : mappingRate >= 0.6 && releaseRecall >= 0.5
        ? "Useful supplemental candidate source"
        : "Not reliable enough for this watchlist";
  const metrics =
    rows.run.metrics && typeof rows.run.metrics === "object"
      ? (rows.run.metrics as Record<string, unknown>)
      : {};
  const lines = [
    "# iTunes Search API Pilot Evaluation",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Environment",
    "",
    `- Feature branch: \`codex/itunes-discovery\``,
    `- Branch-point commit: \`${rows.snapshot.mainRepositoryCommit}\``,
    `- Implementation commit: \`${rows.run.implementationCommit}\``,
    `- Worktree: \`C:\\Users\\taysh\\Documents\\Codex\\codex_world_1_itunes\``,
    `- Compose project: \`codex_world_1_itunes\``,
    `- Web port: \`3001\`; PostgreSQL ports: \`55433\` and \`55434\``,
    `- Pilot database: \`radar_itunes\`; test database: \`radar_itunes_test\``,
    `- Snapshot: ${rows.snapshot.snapshotTimestamp.toISOString()}`,
    `- Ground-truth window: ${rows.snapshot.windowStart} through ${rows.snapshot.windowEnd}`,
    `- Live start: ${rows.run.startedAt?.toISOString() ?? "not started"}`,
    `- Live end: ${rows.run.completedAt?.toISOString() ?? "not completed"}`,
    "",
    "## Cohort",
    "",
    `- Artists: ${rows.artists.length}`,
    `- Positive: ${rows.artists.filter((artist) => artist.cohortReason === "positive").length}`,
    `- Negative: ${rows.artists.filter((artist) => artist.cohortReason === "negative").length}`,
    `- Identity stress: ${rows.artists.filter((artist) => artist.cohortReason === "identity_stress").length}`,
    `- Frozen Spotify releases: ${rows.releases.length}`,
    "- Stored genre representation: unavailable in the source schema; no genres were inferred.",
    "",
    "| Artist | Cohort |",
    "| --- | --- |",
    ...rows.artists.map(
      (artist) => `| ${escapeTable(artist.canonicalName)} | ${artist.cohortReason} |`,
    ),
    "",
    "## Mapping",
    "",
    `- Exact confirmed: ${mappingCount("exact_confirmed")}`,
    `- Evidence confirmed: ${mappingCount("evidence_confirmed")}`,
    `- Ambiguous: ${mappingCount("ambiguous")}`,
    `- No match: ${mappingCount("no_match")}`,
    `- Rejected: ${mappingCount("rejected")}`,
    `- Mapping rate: ${percent(mappingRate)}`,
    "",
    "## Requests",
    "",
    `- Total network requests: ${realRequests.length}`,
    `- Search: ${requestsByCategory.get("artist_search") ?? 0}`,
    `- Album lookups: ${requestsByCategory.get("artist_albums") ?? 0}`,
    `- Song lookups: ${requestsByCategory.get("artist_songs") ?? 0}`,
    `- Batched lookups: ${(requestsByCategory.get("batch_albums") ?? 0) + (requestsByCategory.get("batch_songs") ?? 0)}`,
    `- Collection-detail lookups: ${requestsByCategory.get("collection_songs") ?? 0}`,
    `- Cache hits: ${cacheHits}`,
    `- Runtime: ${(runtimeMs / 60_000).toFixed(2)} minutes`,
    `- Requests per minute: ${runtimeMs > 0 ? ((realRequests.length * 60_000) / runtimeMs).toFixed(2) : "n/a"}`,
    `- Minimum request-start interval: ${minimumInterval ?? "n/a"} ms`,
    `- HTTP errors: ${realRequests.filter((request) => request.errorClassification).length}`,
    `- Retry-After values: ${
      realRequests
        .filter((request) => request.retryAfterSeconds !== null)
        .map((request) => request.retryAfterSeconds)
        .join(", ") || "none"
    }`,
    "",
    "## Discovery",
    "",
    `- Deduplicated collections: ${rows.collections.length}`,
    `- Deduplicated tracks: ${rows.tracks.length}`,
    `- Collections in 7/14/30/60 days: ${[7, 14, 30, 60].map(candidatesByWindow).join(" / ")}`,
    `- Album lookup only: ${rows.collections.filter((collection) => collection.source === "album_lookup").length}`,
    `- Song lookup only: ${rows.collections.filter((collection) => collection.source === "song_lookup").length}`,
    `- Both lookup paths: ${rows.collections.filter((collection) => collection.source === "both").length}`,
    `- Appearance candidates: ${rows.tracks.filter((track) => track.appearance).length}`,
    `- Duplicate collection observations removed: ${metricValue(metrics.deduplicatedCollections)}`,
    `- Duplicate track observations removed: ${metricValue(metrics.deduplicatedTracks)}`,
    "",
    "## Comparison",
    "",
    `- Artist-level recall: ${percent(artistRecall)}`,
    `- Release-level recall: ${percent(releaseRecall)}`,
    `- Candidate precision proxy: ${percent(precisionProxy)}`,
    `- Recall at 7/14/30/60 days: ${[7, 14, 30, 60].map((days) => percent(recallByWindow(days))).join(" / ")}`,
    `- Exact matches: ${rows.matches.filter((match) => match.classification === "exact_match").length}`,
    `- Strong probable matches: ${rows.matches.filter((match) => match.classification === "strong_probable_match").length}`,
    `- Ambiguous matches: ${rows.matches.filter((match) => match.classification === "ambiguous_match").length}`,
    `- Apple-only or unresolved: ${rows.matches.filter((match) => match.classification === "apple_only_or_spotify_missing").length}`,
    `- Spotify releases missed by iTunes: ${rows.matches.filter((match) => match.classification === "spotify_ground_truth_missed_by_itunes").length}`,
    `- Identity mapping failures: ${rows.matches.filter((match) => match.classification === "identity_mapping_failure").length}`,
    `- Track-count agreement: ${percent(ratio(rows.matches.filter((match) => match.trackCountAgreement === true).length, rows.matches.filter((match) => match.trackCountAgreement !== null).length))}`,
    "",
    "## Batching",
    "",
    ...rows.batches.map(
      (batch) =>
        `- ${batch.entity}, size ${batch.batchSize}: ${batch.safe ? "safe" : "unsafe"}; ${batch.batchResultCount}/${batch.individualResultCount} results; ${stringArray(batch.reasons).join(", ") || "equivalent"}`,
    ),
    `- Proven safe batch size: ${safeBatchSize || "none"}`,
    "",
    "## Projected 593-Artist Operation",
    "",
    `- One-time mapping requests: 593`,
    `- Recurring individual lookup requests: ${fullIndividualRequests}`,
    `- Recurring batched lookup requests: ${fullBatchRequests ?? "not projected because batching was not proven safe"}`,
    `- Individual lookup runtime at 3.2 seconds: ${((fullIndividualRequests * 3.2) / 60).toFixed(1)} minutes`,
    `- Projected artists with recent candidates: ${projectedCandidateArtists}`,
    `- Projected candidate-driven Spotify confirmation requests: ${projectedCandidateArtists}`,
    `- Projected reduction from 593 Spotify artist-catalog requests: ${projectedSpotifyReduction} (${percent(projectedSpotifyReduction / 593)})`,
    `- Expected weekly iTunes lookup duration: ${(((fullBatchRequests ?? fullIndividualRequests) * 3.2) / 60).toFixed(1)} minutes`,
    "",
    "## Limitations",
    "",
    "- Apple publishes this API only in archived documentation.",
    "- The documented allowance is approximate and subject to change.",
    "- Results vary by storefront.",
    "- Lookup results are capped at 200 and no paging mechanism is proven.",
    "- Artist-name mapping remains ambiguous for same-name and non-exact identities.",
    "- Song lookup does not prove complete appearance coverage.",
    "- Current Apple catalog results are compared with a frozen historical Spotify snapshot.",
    "- Spotify ground truth can itself contain partial artist catalogs.",
    "- Unmatched Apple candidates are not automatically false positives.",
    "- No UPC or ISRC claim is made because those identifiers were not part of the normalized pilot response.",
    "- One snapshot cannot prove future Apple release-availability timing.",
    "- Apple promotional content is not downloaded, cached, rendered, or used; only normalized metadata and validated store links are retained.",
    "",
    "## Decision",
    "",
    `**${recommendation}.**`,
    "",
    recommendation === "Strong candidate for primary discovery sweep"
      ? "Recommended next milestone: merge the isolated provider and implement separately gated candidate-driven Spotify confirmation."
      : recommendation === "Useful supplemental candidate source"
        ? "Recommended next milestone: expand or correct the measured mapping and discovery weaknesses before considering primary-source use."
        : "Recommended next milestone: reject iTunes as the primary source and evaluate another authorized source. SoundCloud automation remains prohibited under current repository policy.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function validateLiveConfiguration(configuration: ProviderConfiguration): void {
  const database = configuration.databaseUrl ? new URL(configuration.databaseUrl) : null;
  if (
    !database ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "55433" ||
    database.pathname !== "/radar_itunes"
  ) {
    throw new Error("Pilot DATABASE_URL is not the isolated radar_itunes database.");
  }
  if (configuration.appBaseUrl !== "http://127.0.0.1:3001") {
    throw new Error("Pilot app base URL must use 127.0.0.1:3001.");
  }
  if (
    configuration.spotify.enabled ||
    configuration.spotify.playlistWritesEnabled ||
    configuration.musicbrainz.enabled ||
    configuration.reddit.enabled ||
    configuration.soundcloudManualLinksEnabled
  ) {
    throw new Error("Every non-iTunes provider must be disabled in pilot mode.");
  }
  if (!configuration.itunes.enabled) {
    throw new Error("ITUNES_DISCOVERY_ENABLED must be explicitly true for the live pilot.");
  }
}

export function toCollectionCandidate(collection: ItunesCollection): ItunesCollectionCandidate {
  return {
    ...(collection.artistId ? { artistId: collection.artistId } : {}),
    ...(collection.artistName ? { artistName: collection.artistName } : {}),
    ...(collection.collectionArtistId ? { collectionArtistId: collection.collectionArtistId } : {}),
    ...(collection.collectionArtistName
      ? { collectionArtistName: collection.collectionArtistName }
      : {}),
    collectionId: collection.collectionId,
    collectionName: collection.collectionName,
    ...(collection.collectionExplicitness
      ? { explicitness: collection.collectionExplicitness }
      : {}),
    ...(collection.primaryGenreName ? { primaryGenreName: collection.primaryGenreName } : {}),
    releaseDate: collection.releaseDate,
    source: "album_lookup",
    ...(collection.trackCount === undefined ? {} : { trackCount: collection.trackCount }),
    ...(collection.collectionViewUrl ? { viewUrl: collection.collectionViewUrl } : {}),
  };
}

export function collectionsFromTracks(tracks: ItunesTrack[]): ItunesCollectionCandidate[] {
  const collections = new Map<string, ItunesCollectionCandidate>();
  for (const track of tracks) {
    if (!track.collectionId || !track.collectionName) continue;
    collections.set(track.collectionId, {
      ...(track.artistId ? { artistId: track.artistId } : {}),
      artistName: track.artistName,
      ...(track.collectionArtistId ? { collectionArtistId: track.collectionArtistId } : {}),
      ...(track.collectionArtistName ? { collectionArtistName: track.collectionArtistName } : {}),
      collectionId: track.collectionId,
      collectionName: track.collectionName,
      ...(track.trackExplicitness ? { explicitness: track.trackExplicitness } : {}),
      releaseDate: track.releaseDate,
      source: "song_lookup",
      ...(track.trackCount === undefined ? {} : { trackCount: track.trackCount }),
      ...(track.trackViewUrl ? { viewUrl: track.trackViewUrl } : {}),
    });
  }
  return [...collections.values()];
}

export function toTrackCandidate(track: ItunesTrack): ItunesTrackCandidate {
  return {
    ...(track.artistId ? { artistId: track.artistId } : {}),
    artistName: track.artistName,
    ...(track.collectionArtistId ? { collectionArtistId: track.collectionArtistId } : {}),
    ...(track.collectionArtistName ? { collectionArtistName: track.collectionArtistName } : {}),
    ...(track.collectionId ? { collectionId: track.collectionId } : {}),
    ...(track.collectionName ? { collectionName: track.collectionName } : {}),
    ...(track.discCount === undefined ? {} : { discCount: track.discCount }),
    ...(track.discNumber === undefined ? {} : { discNumber: track.discNumber }),
    ...(track.trackExplicitness ? { explicitness: track.trackExplicitness } : {}),
    releaseDate: track.releaseDate,
    ...(track.trackCount === undefined ? {} : { trackCount: track.trackCount }),
    trackId: track.trackId,
    trackName: track.trackName,
    ...(track.trackNumber === undefined ? {} : { trackNumber: track.trackNumber }),
    ...(track.trackTimeMillis === undefined ? {} : { trackTimeMillis: track.trackTimeMillis }),
    ...(track.trackViewUrl ? { viewUrl: track.trackViewUrl } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function minimumRequestInterval(values: Date[]): number | null {
  if (values.length < 2) return null;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    minimum = Math.min(minimum, values[index]!.getTime() - values[index - 1]!.getTime());
  }
  return Number.isFinite(minimum) ? minimum : null;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function metricValue(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "not recorded";
}
