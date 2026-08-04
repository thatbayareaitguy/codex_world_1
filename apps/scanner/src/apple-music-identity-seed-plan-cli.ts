import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appleMusicAlbums,
  appleMusicRequestEvents,
  appleMusicResponseCache,
  appleMusicSongs,
  advanceAppleMusicIdentityCampaign,
  claimAppleMusicPilotLease,
  createAppleMusicComparisonRun,
  createAppleMusicRequestPersistence,
  createDatabase,
  finishAppleMusicComparisonRun,
  finishAppleMusicIdentityCampaign,
  getAppleMusicIdentityCampaign,
  getAppleMusicOperationalStatus,
  getLatestAppleMusicOperationalSnapshotId,
  listAppleMusicIdentityCampaignEntries,
  listDurableAppleMusicArtistMappings,
  releaseAppleMusicPilotLease,
  saveAppleMusicArtistMapping,
  saveDurableAppleMusicArtistMapping,
  seedAppleMusicIdentityCampaignEntries,
  startAppleMusicIdentityCampaign,
  updateAppleMusicIdentityCampaignEntry,
  type RadarDatabase,
} from "@radar/db";
import {
  AppleDeveloperTokenManager,
  AppleMusicClient,
  loadProviderConfiguration,
} from "@radar/providers";
import { asc, eq } from "drizzle-orm";
import {
  createAppleMusicFullWatchlistPlan,
  createAppleMusicManualReviewArtifacts,
  authorizeAppleMusicFullWatchlist,
  appleMusicFullWatchlistConfirmation,
  runAppleMusicFullWatchlistStrongSeeds,
  type AppleMusicFullWatchlistCampaignEntry,
  type AppleMusicFullWatchlistStore,
} from "./apple-music-full-watchlist-mapping";
import {
  createAppleMusicIdentitySeedPlan,
  readAppleMusicIdentitySeedArtifact,
  validateApprovedAppleMusicIdentitySeedArtifact,
} from "./apple-music-identity-seed-artifact";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import {
  buildAppleMusicStageBGroundTruth,
  createAppleMusicStageBPhase2Plan,
  createAppleMusicStageBReviewArtifact,
  createAppleMusicStageBReviewHtml,
  extractAppleMusicStageBCandidateCatalogs,
  replayAppleMusicStageB,
  validateAppleMusicStageBReviewArtifact,
  type AppleMusicStageBSourceRelease,
} from "./apple-music-stage-b";
import {
  appleMusicStageBLiveConfirmation,
  appleMusicStageBLiveMaximumRuntimeMs,
  appleMusicStageBLiveMinimumRequestIntervalMs,
  appleMusicStageBLiveRequestBudget,
  authorizeAppleMusicStageBLive,
  createAppleMusicStageBLivePlan,
  createAppleMusicStageBLiveScope,
  runAppleMusicStageBLive,
  type AppleMusicStageBLiveScope,
  type AppleMusicStageBLiveStore,
} from "./apple-music-stage-b-live";
import { latestItunesSnapshot, pilotGroundTruth } from "./itunes-pilot-repository";
import { loadLocalEnvironment } from "./local-env";

export type AppleMusicIdentitySeedCommand =
  | { artifactPath: string; mode: "plan" }
  | { artifactPath: string; mode: "full_watchlist_plan" }
  | { artifactPath: string; mode: "stage_b_evidence_replay" }
  | { artifactPath: string; mode: "stage_b_candidate_evidence_plan" }
  | {
      artifactPath: string;
      confirmation: typeof appleMusicStageBLiveConfirmation;
      mode: "stage_b_candidate_evidence_live";
    }
  | {
      artifactPath: string;
      confirmation: typeof appleMusicFullWatchlistConfirmation;
      mode: "strong_seeds_live";
      stage: "strong_seeds";
    }
  | {
      artifactPath: string;
      localOutputPath: string;
      markdownOutputPath: string;
      mode: "report";
    };

export function parseAppleMusicIdentitySeedPlanCommand(
  args: string[],
): AppleMusicIdentitySeedCommand {
  const artifactPath = requiredOption(args, "--artifact");
  if (args.includes("--report")) {
    assertExactArguments(args, [
      "--report",
      "--artifact",
      artifactPath,
      "--markdown-output",
      requiredOption(args, "--markdown-output"),
      "--local-output",
      requiredOption(args, "--local-output"),
    ]);
    return {
      artifactPath,
      localOutputPath: requiredOption(args, "--local-output"),
      markdownOutputPath: requiredOption(args, "--markdown-output"),
      mode: "report",
    };
  }
  if (args.includes("--execute-live")) {
    const confirmation = requiredOption(args, "--confirm-live");
    if (args.includes("--stage-b-candidate-evidence")) {
      assertExactArguments(args, [
        "--execute-live",
        "--confirm-live",
        confirmation,
        "--stage-b-candidate-evidence",
        "--artifact",
        artifactPath,
      ]);
      if (confirmation !== appleMusicStageBLiveConfirmation) {
        throw new Error(
          `Apple Stage B requires --confirm-live ${appleMusicStageBLiveConfirmation}.`,
        );
      }
      return {
        artifactPath,
        confirmation: appleMusicStageBLiveConfirmation,
        mode: "stage_b_candidate_evidence_live",
      };
    }
    const stage = requiredOption(args, "--stage");
    assertExactArguments(args, [
      "--execute-live",
      "--confirm-live",
      confirmation,
      "--stage",
      stage,
      "--artifact",
      artifactPath,
    ]);
    if (confirmation !== appleMusicFullWatchlistConfirmation) {
      throw new Error(
        `Strong-seed validation requires --confirm-live ${appleMusicFullWatchlistConfirmation}.`,
      );
    }
    if (stage !== "strong_seeds") throw new Error("Only stage strong_seeds is authorized.");
    return {
      artifactPath,
      confirmation: appleMusicFullWatchlistConfirmation,
      mode: "strong_seeds_live",
      stage: "strong_seeds",
    };
  }
  if (!args.includes("--plan")) {
    throw new Error("Apple identity-seed intake requires --plan, --report, or --execute-live.");
  }
  if (args.includes("--stage-b-evidence-replay")) {
    assertExactArguments(args, ["--plan", "--stage-b-evidence-replay", "--artifact", artifactPath]);
    return { artifactPath, mode: "stage_b_evidence_replay" };
  }
  if (args.includes("--stage-b-candidate-evidence")) {
    assertExactArguments(args, [
      "--plan",
      "--stage-b-candidate-evidence",
      "--artifact",
      artifactPath,
    ]);
    return { artifactPath, mode: "stage_b_candidate_evidence_plan" };
  }
  if (args.includes("--full-watchlist-mapping-bootstrap")) {
    assertExactArguments(args, [
      "--plan",
      "--full-watchlist-mapping-bootstrap",
      "--artifact",
      artifactPath,
    ]);
    return { artifactPath, mode: "full_watchlist_plan" };
  }
  assertExactArguments(args, ["--plan", "--artifact", artifactPath]);
  return { artifactPath, mode: "plan" };
}

async function main(): Promise<void> {
  const command = parseAppleMusicIdentitySeedPlanCommand(process.argv.slice(2));
  const artifact = await readAppleMusicIdentitySeedArtifact(command.artifactPath);
  if (command.mode === "plan") {
    process.stdout.write(
      `${JSON.stringify(createAppleMusicIdentitySeedPlan(artifact), null, 2)}\n`,
    );
    return;
  }
  const databaseUrl = readAppleDatabaseUrlOnly();
  assertAppleDatabase(databaseUrl);
  const connection = createDatabase(databaseUrl);
  let stageBLiveScope: AppleMusicStageBLiveScope | undefined;
  let stageBLiveSnapshotId: string | undefined;
  try {
    if (command.mode === "full_watchlist_plan") {
      const mappings = await listDurableAppleMusicArtistMappings(
        connection.db,
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      process.stdout.write(
        `${JSON.stringify(createAppleMusicFullWatchlistPlan(artifact, mappings), null, 2)}\n`,
      );
      return;
    }
    if (
      command.mode === "stage_b_candidate_evidence_plan" ||
      command.mode === "stage_b_candidate_evidence_live"
    ) {
      validateApprovedAppleMusicIdentitySeedArtifact(artifact);
      const requestCountBefore = await historicalAppleRequestCount(connection.db);
      const durableBefore = await listDurableAppleMusicArtistMappings(
        connection.db,
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      const context = await loadStageBOfflineContext(connection.db, artifact);
      const reviewValue = JSON.parse(
        await readFile(
          resolve(process.cwd(), ".app-runtime/apple-music-stage-b-review.json"),
          "utf8",
        ),
      ) as unknown;
      const review = validateAppleMusicStageBReviewArtifact(reviewValue, artifact.artifactSelfHash);
      const scope = createAppleMusicStageBLiveScope({
        artifact,
        durableMappings: durableBefore,
        groundTruth: context.groundTruth,
        replay: context.replay,
        reviewArtifactHash: review.artifactSelfHash,
      });
      assertStageBReviewScope(review, scope);
      const requestCountAfter = await historicalAppleRequestCount(connection.db);
      const durableAfter = await listDurableAppleMusicArtistMappings(
        connection.db,
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      if (
        requestCountAfter !== requestCountBefore ||
        durableMappingFingerprint(durableAfter) !== durableMappingFingerprint(durableBefore)
      ) {
        throw new Error("Apple Stage B plan changed isolated Apple state.");
      }
      if (command.mode === "stage_b_candidate_evidence_plan") {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...createAppleMusicStageBLivePlan(scope),
              durableMappingsBeforeAndAfter: durableAfter.length,
              historicalAppleHttpStartsBeforeAndAfter: requestCountAfter,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      stageBLiveScope = scope;
      stageBLiveSnapshotId = context.snapshotId;
    }
    if (command.mode === "stage_b_evidence_replay") {
      validateApprovedAppleMusicIdentitySeedArtifact(artifact);
      const requestCountBefore = await historicalAppleRequestCount(connection.db);
      const durableBefore = await listDurableAppleMusicArtistMappings(
        connection.db,
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      const snapshot = await latestItunesSnapshot(connection.db);
      if (!snapshot) throw new Error("The approved frozen Apple-side snapshot is unavailable.");
      const sourceReleases = (await pilotGroundTruth(connection.db, snapshot.id)).map(
        (release): AppleMusicStageBSourceRelease => ({
          canonicalReleaseId: release.canonicalReleaseId,
          evidenceCutoff: snapshot.snapshotTimestamp.toISOString(),
          evidenceSource: "approved_frozen_spotify_snapshot",
          releaseDate: release.releaseDate,
          releaseType: release.releaseType,
          sourceReleaseId: release.spotifyReleaseId,
          title: release.title,
          tracks: parseSnapshotTracks(release.tracks, release.releaseDate),
          watchedArtistId: release.canonicalArtistId,
        }),
      );
      const allowedCandidateIds = new Set(
        artifact.entries.flatMap((entry) => [
          ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
          ...entry.alternateCandidateIds,
        ]),
      );
      const [albumRows, songRows, cacheRows] = await Promise.all([
        connection.db.select().from(appleMusicAlbums),
        connection.db.select().from(appleMusicSongs),
        connection.db.select().from(appleMusicResponseCache),
      ]);
      const candidateCatalogs = extractAppleMusicStageBCandidateCatalogs(
        {
          albums: albumRows.map((album) => ({
            albumId: album.appleAlbumId,
            artistIds: parseStringArray(album.artistIds),
            artistName: album.artistName,
            paginationPath: "offline-sanitized-database",
            pageNumber: album.pageNumber,
            ...(album.releaseDate ? { releaseDate: album.releaseDate } : {}),
            sourceView: parseSourceView(album.sourceView),
            title: album.title,
            ...(album.trackCount === null ? {} : { trackCount: album.trackCount }),
            ...(album.upc ? { upc: album.upc } : {}),
          })),
          artists: [],
          cacheResponses: cacheRows.map((row) => row.response),
          evidenceCutoff: artifact.evidenceCutoffDate,
          songs: songRows.map((song) => ({
            ...(song.appleAlbumId ? { albumId: song.appleAlbumId } : {}),
            artistIds: parseStringArray(song.artistIds),
            artistName: song.artistName,
            ...(song.discNumber === null ? {} : { discNumber: song.discNumber }),
            ...(song.durationMs === null ? {} : { durationMs: song.durationMs }),
            ...(song.isrc ? { isrc: song.isrc } : {}),
            paginationPath: "offline-sanitized-database",
            pageNumber: song.pageNumber,
            ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
            songId: song.appleSongId,
            title: song.title,
            ...(song.trackNumber === null ? {} : { trackNumber: song.trackNumber }),
          })),
        },
        allowedCandidateIds,
      );
      const groundTruth = buildAppleMusicStageBGroundTruth(artifact, sourceReleases);
      const replay = replayAppleMusicStageB({
        artifact,
        candidateCatalogs,
        groundTruth,
        now: new Date(artifact.evidenceCutoffDate),
      });
      const review = createAppleMusicStageBReviewArtifact({
        artifact,
        candidateCatalogs,
        createdAt: new Date(artifact.evidenceCutoffDate),
        replay,
        resolvedWatchedArtistIds: new Set(
          durableBefore.map((mapping) => mapping.canonicalArtistId),
        ),
      });
      const jsonPath = assertOutputPath(
        ".app-runtime/apple-music-stage-b-review.json",
        ".app-runtime",
      );
      const htmlPath = assertOutputPath(
        ".app-runtime/apple-music-stage-b-review.html",
        ".app-runtime",
      );
      await mkdir(dirname(jsonPath), { recursive: true });
      await Promise.all([
        writeFile(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8"),
        writeFile(htmlPath, createAppleMusicStageBReviewHtml(review), "utf8"),
      ]);
      const requestCountAfter = await historicalAppleRequestCount(connection.db);
      const durableAfter = await listDurableAppleMusicArtistMappings(
        connection.db,
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      if (requestCountAfter !== requestCountBefore) {
        throw new Error("Apple Stage B replay changed the historical HTTP-start count.");
      }
      if (durableMappingFingerprint(durableAfter) !== durableMappingFingerprint(durableBefore)) {
        throw new Error("Apple Stage B replay changed durable mappings.");
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            coverage: replay.coverage,
            counts: replay.counts,
            durableMappingsBeforeAndAfter: durableAfter.length,
            historicalAppleHttpStartsBeforeAndAfter: requestCountAfter,
            localReviewArtifactsWritten: 2,
            mode: replay.mode,
            phase2Plan: createAppleMusicStageBPhase2Plan({
              artifact,
              candidateCatalogs,
              replay,
            }),
            safety: replay.safety,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (command.mode === "report") {
      validateApprovedAppleMusicIdentitySeedArtifact(artifact);
      const campaign = await getAppleMusicIdentityCampaign(
        connection.db,
        artifact.artifactSelfHash,
        "strong_seeds",
      );
      if (!campaign) throw new Error("No strong-seed campaign exists for this artifact.");
      const outputs = createAppleMusicManualReviewArtifacts(
        artifact,
        await readCampaignEntries(connection.db, campaign.id),
      );
      const markdownPath = assertOutputPath(command.markdownOutputPath, "docs");
      const localPath = assertOutputPath(command.localOutputPath, ".app-runtime");
      await writeFile(markdownPath, outputs.markdown, { encoding: "utf8" });
      await writeFile(localPath, outputs.localJson, { encoding: "utf8" });
      const localEntries = JSON.parse(outputs.localJson) as unknown;
      if (!Array.isArray(localEntries)) throw new Error("Local review output must be an array.");
      process.stdout.write(
        `${JSON.stringify({ localEntriesWritten: localEntries.length, mode: "identity_review_report", networkRequestsStarted: 0 }, null, 2)}\n`,
      );
      return;
    }
  } finally {
    if (
      command.mode !== "strong_seeds_live" &&
      command.mode !== "stage_b_candidate_evidence_live"
    ) {
      await connection.client.end();
    }
  }
  try {
    const environment = loadLocalEnvironment(
      process.env,
      resolve(process.cwd(), ".app-runtime/apple-music.env"),
    );
    const configuration = loadProviderConfiguration(environment);
    if (command.mode === "stage_b_candidate_evidence_live") {
      if (!stageBLiveScope || !stageBLiveSnapshotId) {
        throw new Error("Apple Stage B live scope was not validated.");
      }
      const authorization = authorizeAppleMusicStageBLive({
        confirmation: command.confirmation,
        executeLive: true,
        otherProvidersDisabled: otherProvidersDisabled(configuration),
        persistentAppleMusicEnabled: environment.APPLE_MUSIC_ENABLED,
        storefront: configuration.appleMusic.storefront,
      });
      assertLiveCheckpoint();
      assertLiveCredentialShape(configuration.appleMusic);
      let tokenManager: AppleDeveloperTokenManager | undefined;
      const summary = await runAppleMusicStageBLive({
        authorization,
        createClient: (runId, leaseToken) => {
          tokenManager ??= new AppleDeveloperTokenManager({
            keyId: configuration.appleMusic.keyId!,
            privateKeyPath: configuration.appleMusic.privateKeyPath!,
            teamId: configuration.appleMusic.teamId!,
            tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
          });
          return new AppleMusicClient({
            enabled: true,
            maxRequestsPerRun: appleMusicStageBLiveRequestBudget,
            maxResponseBytes: configuration.appleMusic.maxResponseBytes,
            maximumRuntimeMs: appleMusicStageBLiveMaximumRuntimeMs,
            maxRetries: 1,
            minRequestIntervalMs: appleMusicStageBLiveMinimumRequestIntervalMs,
            persistence: createAppleMusicRequestPersistence(connection.db, {
              runLeaseToken: leaseToken,
            }),
            requestTimeoutMs: configuration.appleMusic.requestTimeoutMs,
            runId,
            storefront: authorization.storefront,
            tokenProvider: tokenManager,
          });
        },
        implementationCommit: git(["rev-parse", "HEAD"]),
        scope: stageBLiveScope,
        snapshotId: stageBLiveSnapshotId,
        store: createStageBLiveStore(connection.db),
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    const authorization = authorizeAppleMusicFullWatchlist({
      confirmation: command.confirmation,
      executeLive: true,
      otherProvidersDisabled: otherProvidersDisabled(configuration),
      persistentAppleMusicEnabled: environment.APPLE_MUSIC_ENABLED,
      stage: command.stage,
      storefront: configuration.appleMusic.storefront,
    });
    assertLiveCheckpoint();
    assertLiveCredentialShape(configuration.appleMusic);
    let tokenManager: AppleDeveloperTokenManager | undefined;
    const summary = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization,
      createClient: (runId, leaseToken) => {
        tokenManager ??= new AppleDeveloperTokenManager({
          keyId: configuration.appleMusic.keyId!,
          privateKeyPath: configuration.appleMusic.privateKeyPath!,
          teamId: configuration.appleMusic.teamId!,
          tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
        });
        return new AppleMusicClient({
          enabled: true,
          maxRequestsPerRun: 40,
          maxResponseBytes: configuration.appleMusic.maxResponseBytes,
          maximumRuntimeMs: 600_000,
          maxRetries: 1,
          minRequestIntervalMs: 1_100,
          persistence: createAppleMusicRequestPersistence(connection.db, {
            runLeaseToken: leaseToken,
          }),
          requestTimeoutMs: configuration.appleMusic.requestTimeoutMs,
          runId,
          storefront: authorization.storefront,
          tokenProvider: tokenManager,
        });
      },
      implementationCommit: git(["rev-parse", "HEAD"]),
      store: createStore(connection.db),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await connection.client.end();
  }
}

function createStore(db: RadarDatabase): AppleMusicFullWatchlistStore {
  return {
    advanceCampaign: (campaignId, nextBatchIndex) =>
      advanceAppleMusicIdentityCampaign(db, campaignId, nextBatchIndex),
    claimLease: (runId) => claimAppleMusicPilotLease(db, runId),
    createRun: (input) => createAppleMusicComparisonRun(db, input),
    findCampaign: (artifactHash, stage) => getAppleMusicIdentityCampaign(db, artifactHash, stage),
    finishCampaign: (campaignId, input) => finishAppleMusicIdentityCampaign(db, campaignId, input),
    finishRun: (runId, input) => finishAppleMusicComparisonRun(db, runId, input),
    latestOperationalSnapshotId: () => getLatestAppleMusicOperationalSnapshotId(db),
    listCampaignEntries: (campaignId) => readCampaignEntries(db, campaignId),
    listDurableMappings: (canonicalArtistIds) =>
      listDurableAppleMusicArtistMappings(db, canonicalArtistIds),
    operationalStatus: () => getAppleMusicOperationalStatus(db),
    readEvidence: (runId) => readStoredEvidence(db, runId),
    releaseLease: (leaseToken) => releaseAppleMusicPilotLease(db, leaseToken),
    saveDurableMapping: (input) => saveDurableAppleMusicArtistMapping(db, input),
    saveMapping: async (input) => {
      await saveAppleMusicArtistMapping(db, input);
    },
    seedCampaignEntries: (campaignId, entries) =>
      seedAppleMusicIdentityCampaignEntries(db, campaignId, entries),
    startCampaign: (input) => startAppleMusicIdentityCampaign(db, input),
    updateCampaignEntry: (input) => updateAppleMusicIdentityCampaignEntry(db, input),
  };
}

function createStageBLiveStore(db: RadarDatabase): AppleMusicStageBLiveStore {
  return {
    claimLease: (runId) => claimAppleMusicPilotLease(db, runId),
    createRun: (input) => createAppleMusicComparisonRun(db, input),
    finishRun: (runId, input) => finishAppleMusicComparisonRun(db, runId, input),
    listDurableMappings: (canonicalArtistIds) =>
      listDurableAppleMusicArtistMappings(db, canonicalArtistIds),
    operationalStatus: () => getAppleMusicOperationalStatus(db),
    readEvidence: (runId) => readStoredEvidence(db, runId),
    releaseLease: (leaseToken) => releaseAppleMusicPilotLease(db, leaseToken),
    saveDurableMapping: (input) => saveDurableAppleMusicArtistMapping(db, input),
    saveMapping: async (input) => {
      await saveAppleMusicArtistMapping(db, input);
    },
  };
}

function assertStageBReviewScope(
  review: ReturnType<typeof validateAppleMusicStageBReviewArtifact>,
  scope: AppleMusicStageBLiveScope,
): void {
  const eligible = review.artists.filter(
    (artist) => artist.classification === "requires_live_candidate_evidence",
  );
  const reviewById = new Map(eligible.map((artist) => [artist.watchedArtistId, artist]));
  if (eligible.length !== 6) {
    throw new Error("Apple Stage B review does not contain the exact six-artist live scope.");
  }
  for (const artist of scope.artists) {
    const reviewArtist = reviewById.get(artist.watchedArtistId);
    if (
      !reviewArtist ||
      reviewArtist.canonicalName !== artist.canonicalName ||
      reviewArtist.candidates.length !== artist.candidateArtistIds.length ||
      reviewArtist.candidates.some(
        (candidate) => !artist.candidateArtistIds.includes(candidate.candidateArtistId),
      )
    ) {
      throw new Error("Apple Stage B review scope differs from the replay-derived live scope.");
    }
  }
}

async function loadStageBOfflineContext(
  db: RadarDatabase,
  artifact: Awaited<ReturnType<typeof readAppleMusicIdentitySeedArtifact>>,
) {
  const snapshot = await latestItunesSnapshot(db);
  if (!snapshot) throw new Error("The approved frozen Apple-side snapshot is unavailable.");
  const sourceReleases = (await pilotGroundTruth(db, snapshot.id)).map(
    (release): AppleMusicStageBSourceRelease => ({
      canonicalReleaseId: release.canonicalReleaseId,
      evidenceCutoff: snapshot.snapshotTimestamp.toISOString(),
      evidenceSource: "approved_frozen_spotify_snapshot",
      releaseDate: release.releaseDate,
      releaseType: release.releaseType,
      sourceReleaseId: release.spotifyReleaseId,
      title: release.title,
      tracks: parseSnapshotTracks(release.tracks, release.releaseDate),
      watchedArtistId: release.canonicalArtistId,
    }),
  );
  const allowedCandidateIds = new Set(
    artifact.entries.flatMap((entry) => [
      ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
      ...entry.alternateCandidateIds,
    ]),
  );
  const [albumRows, songRows, cacheRows] = await Promise.all([
    db.select().from(appleMusicAlbums),
    db.select().from(appleMusicSongs),
    db.select().from(appleMusicResponseCache),
  ]);
  const candidateCatalogs = extractAppleMusicStageBCandidateCatalogs(
    {
      albums: albumRows.map((album) => ({
        albumId: album.appleAlbumId,
        artistIds: parseStringArray(album.artistIds),
        artistName: album.artistName,
        paginationPath: "offline-sanitized-database",
        pageNumber: album.pageNumber,
        ...(album.releaseDate ? { releaseDate: album.releaseDate } : {}),
        sourceView: parseSourceView(album.sourceView),
        title: album.title,
        ...(album.trackCount === null ? {} : { trackCount: album.trackCount }),
        ...(album.upc ? { upc: album.upc } : {}),
      })),
      artists: [],
      cacheResponses: cacheRows.map((row) => row.response),
      evidenceCutoff: artifact.evidenceCutoffDate,
      songs: songRows.map((song) => ({
        ...(song.appleAlbumId ? { albumId: song.appleAlbumId } : {}),
        artistIds: parseStringArray(song.artistIds),
        artistName: song.artistName,
        ...(song.discNumber === null ? {} : { discNumber: song.discNumber }),
        ...(song.durationMs === null ? {} : { durationMs: song.durationMs }),
        ...(song.isrc ? { isrc: song.isrc } : {}),
        paginationPath: "offline-sanitized-database",
        pageNumber: song.pageNumber,
        ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
        songId: song.appleSongId,
        title: song.title,
        ...(song.trackNumber === null ? {} : { trackNumber: song.trackNumber }),
      })),
    },
    allowedCandidateIds,
  );
  const groundTruth = buildAppleMusicStageBGroundTruth(artifact, sourceReleases);
  return {
    candidateCatalogs,
    groundTruth,
    replay: replayAppleMusicStageB({
      artifact,
      candidateCatalogs,
      groundTruth,
      now: new Date(artifact.evidenceCutoffDate),
    }),
    snapshotId: snapshot.id,
  };
}

async function readCampaignEntries(
  db: RadarDatabase,
  campaignId: string,
): Promise<AppleMusicFullWatchlistCampaignEntry[]> {
  return (await listAppleMusicIdentityCampaignEntries(db, campaignId)).map((entry) => ({
    artifactClassification: entry.artifactClassification,
    attempts: entry.attempts,
    batchIndex: entry.batchIndex,
    candidateCount: entry.candidateCount,
    canonicalArtistId: entry.canonicalArtistId,
    evidence: entry.evidence,
    manualReviewReason: entry.manualReviewReason,
    selectedAppleArtistId: entry.selectedAppleArtistId,
    selectedArtistName: entry.selectedArtistName,
    status: entry.status as AppleMusicFullWatchlistCampaignEntry["status"],
    validationPath: entry.validationPath,
  }));
}

async function readStoredEvidence(
  db: RadarDatabase,
  runId: string,
): Promise<AppleMusicPilotStoredEvidence> {
  const events = await db
    .select({
      cacheHit: appleMusicRequestEvents.cacheHit,
      endpointCategory: appleMusicRequestEvents.endpointCategory,
      requestIdentity: appleMusicRequestEvents.requestIdentity,
      startedAt: appleMusicRequestEvents.startedAt,
      status: appleMusicRequestEvents.status,
    })
    .from(appleMusicRequestEvents)
    .where(eq(appleMusicRequestEvents.runId, runId))
    .orderBy(asc(appleMusicRequestEvents.startedAt));
  const network = events.filter((event) => !event.cacheHit);
  const intervals = network
    .slice(1)
    .map((event, index) => event.startedAt.getTime() - network[index]!.startedAt.getTime());
  return {
    authenticationAttempts: 0,
    cacheHits: events.length - network.length,
    endpointRequestCounts: countBy(network.map((event) => event.endpointCategory)),
    httpStatusCounts: countBy(
      network.map((event) => (event.status === null ? "none" : String(event.status))),
    ),
    maximumConcurrency: network.length > 0 ? 1 : 0,
    ...(intervals.length > 0 ? { minimumRequestIntervalMs: Math.min(...intervals) } : {}),
    paginationRequests: 0,
    requestCount: network.length,
    retryCount: Math.max(
      0,
      network.length - new Set(network.map((event) => event.requestIdentity)).size,
    ),
  };
}

function readAppleDatabaseUrlOnly(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return "postgres://radar:radar@127.0.0.1:55435/radar_apple";
}

function assertAppleDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55435" ||
    url.pathname !== "/radar_apple"
  ) {
    throw new Error("Refusing to use a database other than the isolated radar_apple database.");
  }
}

function assertLiveCheckpoint(): void {
  if (git(["branch", "--show-current"]) !== "codex/apple-music-discovery") {
    throw new Error("Strong-seed validation requires codex/apple-music-discovery.");
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("Strong-seed validation requires a clean implementation checkpoint.");
  }
  if (git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]) !== "0\t0") {
    throw new Error("Strong-seed validation requires synchronized local and upstream branches.");
  }
}

function assertLiveCredentialShape(
  configuration: ReturnType<typeof loadProviderConfiguration>["appleMusic"],
): void {
  if (
    !configuration.teamId ||
    !configuration.keyId ||
    !configuration.mediaId ||
    !configuration.privateKeyPath
  ) {
    throw new Error("The isolated Apple catalog credentials are incomplete.");
  }
}

function otherProvidersDisabled(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): boolean {
  return (
    !configuration.spotify.enabled &&
    !configuration.spotify.playlistWritesEnabled &&
    !configuration.itunes.enabled &&
    !configuration.musicbrainz.enabled &&
    !configuration.reddit.enabled &&
    !configuration.soundcloudManualLinksEnabled
  );
}

function assertOutputPath(path: string, directory: "docs" | ".app-runtime"): string {
  const output = resolve(path);
  const allowed = resolve(process.cwd(), directory);
  if (output !== allowed && !output.startsWith(`${allowed}\\`)) {
    throw new Error(`Output must remain under ${directory}.`);
  }
  return output;
}

function requiredOption(args: string[], name: string): string {
  const positions = args.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length !== 1) throw new Error(`${name} must be provided exactly once.`);
  const value = args[positions[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function assertExactArguments(args: string[], expected: string[]): void {
  if (args.length !== expected.length) throw new Error("Unexpected Apple identity-seed argument.");
  const remaining = [...expected];
  for (const value of args) {
    const index = remaining.indexOf(value);
    if (index < 0) throw new Error(`Unexpected Apple identity-seed argument: ${value}`);
    remaining.splice(index, 1);
  }
  if (remaining.length > 0) throw new Error("Apple identity-seed arguments are incomplete.");
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function durableMappingFingerprint(
  mappings: Awaited<ReturnType<typeof listDurableAppleMusicArtistMappings>>,
): string {
  return JSON.stringify(
    [...mappings].sort((left, right) =>
      left.canonicalArtistId.localeCompare(right.canonicalArtistId),
    ),
  );
}

async function historicalAppleRequestCount(db: RadarDatabase): Promise<number> {
  const rows = await db
    .select({ id: appleMusicRequestEvents.id })
    .from(appleMusicRequestEvents)
    .where(eq(appleMusicRequestEvents.cacheHit, false));
  return rows.length;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSnapshotTracks(
  value: unknown,
  releaseDate: string,
): AppleMusicStageBSourceRelease["tracks"] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((track) => {
    if (!isRecord(track) || typeof track.title !== "string") return [];
    const durationMs =
      "durationMs" in track && typeof track.durationMs === "number" ? track.durationMs : undefined;
    const isrc = "isrc" in track && typeof track.isrc === "string" ? track.isrc : undefined;
    return [
      {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(isrc ? { isrc } : {}),
        releaseDate,
        title: track.title,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseSourceView(value: string) {
  const supported = new Set([
    "latest-release",
    "singles",
    "full-albums",
    "live-albums",
    "compilation-albums",
    "appears-on-albums",
    "album",
  ]);
  if (!supported.has(value)) return "album" as const;
  return value as
    | "latest-release"
    | "singles"
    | "full-albums"
    | "live-albums"
    | "compilation-albums"
    | "appears-on-albums"
    | "album";
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", process.cwd(), ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

if (process.argv[1]?.endsWith("apple-music-identity-seed-plan-cli.ts")) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Apple identity-seed command failed."}\n`,
    );
    process.exitCode = 1;
  });
}
