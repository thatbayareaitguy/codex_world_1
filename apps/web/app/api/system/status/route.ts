import {
  artistImportRuns,
  artistFollows,
  artistMappingReviews,
  createDatabase,
  getAppleMusicOperationalStatus,
  getSpotifySchedulerStatus,
  oauthAccounts,
  operationLocks,
  playlistTargets,
  redditCandidateMatches,
  redditReconciliationRuns,
  scanRuns,
} from "@radar/db";
import { loadProviderConfiguration, spotifyAuthorizationScopes } from "@radar/providers";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  const base = {
    appleMusic: {
      configured: configuration.appleMusic.configured,
      enabled: configuration.appleMusic.enabled,
      minRequestIntervalMs: configuration.appleMusic.minRequestIntervalMs,
      storefront: configuration.appleMusic.storefront,
    },
    backup: { lastCompletedAt: lastBackupTime() },
    database: { configured: Boolean(configuration.databaseUrl) },
    generatedAt: new Date().toISOString(),
    ...(configuration.musicbrainz.enabled
      ? {
          musicbrainz: {
            configured: configuration.musicbrainz.configured,
            enabled: true,
            userAgentConfigured: Boolean(configuration.musicbrainz.contactEmail),
          },
        }
      : {}),
    reddit: {
      approvalRecorded: configuration.reddit.accessApproved,
      configured: configuration.reddit.configured,
      credentialsConfigured: Boolean(
        configuration.reddit.clientId && configuration.reddit.clientSecret,
      ),
      enabled: configuration.reddit.enabled,
    },
    scheduler: {
      automaticEnabled: configuration.discoverySchedulerEnabled,
      expectedNextScanAt: null,
      managedByApplication: false,
      recommendedCommand: "pnpm discovery:scheduler:tick",
      schedule:
        "Apple Thursday 9:00 PM and Friday 9:00 AM; Spotify Saturday-Wednesday (America/Los_Angeles)",
    },
    spotify: {
      allowedPlaylistConfigured: Boolean(configuration.spotify.allowedPlaylistId),
      configured: configuration.spotify.configured,
      enabled: configuration.spotify.enabled,
      expectedPlaylistPublic: configuration.spotify.expectedPlaylistPublic,
      playlistWritesEnabled: configuration.spotify.playlistWritesEnabled,
      playlistWritePolicy: "authorized_owner_non_collaborative",
      redirectUriValid:
        configuration.spotify.redirectUri === "http://127.0.0.1:3000/api/auth/spotify/callback",
      requiredScopes: [
        ...spotifyAuthorizationScopes(
          configuration.spotify.playlistWritesEnabled &&
            Boolean(configuration.spotify.allowedPlaylistId),
        ),
      ],
    },
  };
  if (!configuration.databaseUrl) {
    return NextResponse.json({ ...base, database: { configured: false, state: "unavailable" } });
  }

  const connection = createDatabase(configuration.databaseUrl);
  try {
    const [
      migrationRows,
      recentRuns,
      locks,
      account,
      playlist,
      spotifyImport,
      musicbrainzMappingReview,
      redditReview,
      reconcile,
      spotifyScheduler,
      appleMusicMappingReview,
      appleMusicOperational,
    ] = await Promise.all([
      connection.client<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `,
      connection.db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(100),
      connection.db.select().from(operationLocks),
      connection.db.query.oauthAccounts.findFirst({
        where: eq(oauthAccounts.provider, "spotify"),
        orderBy: desc(oauthAccounts.updatedAt),
      }),
      connection.db.query.playlistTargets.findFirst({
        where: eq(playlistTargets.provider, "spotify"),
        orderBy: desc(playlistTargets.updatedAt),
      }),
      connection.db.query.artistImportRuns.findFirst({
        where: inArray(artistImportRuns.status, ["completed", "partial"]),
        orderBy: desc(artistImportRuns.createdAt),
      }),
      configuration.musicbrainz.enabled
        ? connection.db
            .select({ count: sql<number>`count(*)::int` })
            .from(artistMappingReviews)
            .innerJoin(artistFollows, eq(artistFollows.artistId, artistMappingReviews.artistId))
            .where(
              and(
                eq(artistMappingReviews.provider, "musicbrainz"),
                eq(artistMappingReviews.status, "pending"),
                eq(artistFollows.active, true),
              ),
            )
        : Promise.resolve([{ count: 0 }]),
      connection.db
        .select({ count: sql<number>`count(*)::int` })
        .from(redditCandidateMatches)
        .where(eq(redditCandidateMatches.reviewStatus, "needs_review")),
      connection.db
        .select()
        .from(redditReconciliationRuns)
        .orderBy(desc(redditReconciliationRuns.startedAt))
        .limit(1),
      getSpotifySchedulerStatus(connection.db),
      connection.db
        .select({ count: sql<number>`count(*)::int` })
        .from(artistMappingReviews)
        .innerJoin(artistFollows, eq(artistFollows.artistId, artistMappingReviews.artistId))
        .where(
          and(
            eq(artistMappingReviews.provider, "apple_music"),
            eq(artistMappingReviews.status, "pending"),
            eq(artistFollows.active, true),
          ),
        ),
      getAppleMusicOperationalStatus(connection.db),
    ]);
    const latest = (provider: "apple_music" | "spotify" | "musicbrainz" | "reddit") =>
      recentRuns.find((run) => run.provider === provider);
    const successful = (provider: "apple_music" | "spotify" | "musicbrainz" | "reddit") =>
      recentRuns.find((run) => run.provider === provider && run.status === "completed");
    const now = Date.now();
    const activeLocks = locks.filter((lock) => lock.expiresAt.getTime() > now);
    const staleLocks = locks.filter((lock) => lock.expiresAt.getTime() <= now);
    const spotifyLatest = latest("spotify");
    const appleMusicLatest = latest("apple_music");
    const musicBrainzLatest = configuration.musicbrainz.enabled ? latest("musicbrainz") : undefined;
    const redditLatest = latest("reddit");
    const running = recentRuns.find((run) => run.status === "running");
    const lastCompleted = recentRuns.find((run) => run.completedAt);

    return NextResponse.json({
      ...base,
      appleMusic: {
        ...base.appleMusic,
        cooldownActive: appleMusicOperational.cooldownActive,
        cooldownUntil: appleMusicOperational.cooldownUntil,
        lastError: scanError(appleMusicLatest?.errors),
        lastSuccessfulScanAt: successful("apple_music")?.completedAt ?? null,
        leaseActive: appleMusicOperational.leaseActive,
        mappingReviewCount: appleMusicMappingReview[0]?.count ?? 0,
        queueDepth: appleMusicOperational.queueDepth,
        requestCount: appleMusicOperational.requestCount,
      },
      database: {
        configured: true,
        connected: true,
        migrationCount: migrationRows[0]?.count ?? 0,
        migrationCurrent: (migrationRows[0]?.count ?? 0) >= expectedMigrationCount(),
        state: "connected",
      },
      ...(configuration.musicbrainz.enabled && base.musicbrainz
        ? {
            musicbrainz: {
              ...base.musicbrainz,
              lastError: scanError(musicBrainzLatest?.errors),
              lastRateLimitWaitMs: metricNumber(musicBrainzLatest?.metadata, "waitMs"),
              lastSuccessfulScanAt: successful("musicbrainz")?.completedAt ?? null,
              mappingReviewCount: musicbrainzMappingReview[0]?.count ?? 0,
            },
          }
        : {}),
      reddit: {
        ...base.reddit,
        lastDeletionReconciliationAt: reconcile[0]?.completedAt ?? null,
        lastError: scanError(redditLatest?.errors),
        lastScanAt: redditLatest?.completedAt ?? redditLatest?.startedAt ?? null,
        reviewCount: redditReview[0]?.count ?? 0,
      },
      scanner: {
        activeScanId: running?.id ?? null,
        failedProviderCount: recentRuns.filter((run) =>
          inArrayValue(run.status, ["failed", "partial"]),
        ).length,
        lastCompletedAt: lastCompleted?.completedAt ?? null,
        lockCount: activeLocks.length,
        running: Boolean(running || activeLocks.length > 0),
        staleLockCount: staleLocks.length,
      },
      spotify: {
        ...base.spotify,
        connected: Boolean(account && !account.disconnectedAt && !account.reconnectRequired),
        followedArtistsImported: Boolean(spotifyImport),
        grantedScopes: account?.scopes ?? [],
        lastError: scanError(spotifyLatest?.errors),
        lastPlaylistSyncAt: playlist?.lastSyncedAt ?? null,
        lastSuccessfulRequestAt: null,
        lastSuccessfulScanAt: successful("spotify")?.completedAt ?? null,
        playlistConfigured: Boolean(configuration.spotify.allowedPlaylistId),
        scheduler: spotifyScheduler,
      },
    });
  } catch {
    return NextResponse.json(
      {
        ...base,
        database: {
          configured: true,
          error: "Database status could not be read. Run pnpm doctor for remediation.",
          state: "unavailable",
        },
      },
      { status: 503 },
    );
  } finally {
    await connection.client.end();
  }
}

function expectedMigrationCount(): number {
  try {
    return readdirSync(resolve(process.cwd(), "packages", "db", "drizzle")).filter((name) =>
      /^\d{4}_.+\.sql$/.test(name),
    ).length;
  } catch {
    return 0;
  }
}

function lastBackupTime(): string | null {
  const directory =
    process.env.APP_BACKUP_DIR ??
    join(
      process.env.APP_DATA_DIR ?? process.env.LOCALAPPDATA ?? resolve(".app-runtime"),
      "backups",
    );
  const file = join(directory, "last-backup.json");
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      "completedAt" in value &&
      typeof value.completedAt === "string"
    ) {
      return value.completedAt;
    }
  } catch {
    return null;
  }
  return null;
}

function scanError(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  if (!first || typeof first !== "object") return null;
  const message: unknown = Reflect.get(first, "message");
  return typeof message === "string" ? message.slice(0, 500) : null;
}

function metricNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || !("providerMetrics" in value)) return null;
  const metrics = value.providerMetrics;
  if (!metrics || typeof metrics !== "object" || !(key in metrics)) return null;
  const result = metrics[key as keyof typeof metrics];
  return typeof result === "number" ? result : null;
}

function inArrayValue<T>(value: T, candidates: readonly T[]): boolean {
  return candidates.includes(value);
}
