import { z } from "zod";
import { spotifyAuthorizedPlaylistId, spotifyPlaylistIdSchema } from "./spotify-playlist-policy";

const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

const optionalSpotifyPlaylistId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  spotifyPlaylistIdSchema.optional(),
);

const environmentSchema = z
  .object({
    APPLE_MUSIC_ENABLED: booleanFlag(false),
    APPLE_MUSIC_KEY_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    APPLE_MUSIC_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(1500),
    APPLE_MUSIC_MAX_RUNTIME_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(14_400_000)
      .default(7_200_000),
    APPLE_MUSIC_MIN_REQUEST_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1100)
      .max(300_000)
      .default(1100),
    APPLE_MUSIC_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    APPLE_MUSIC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    APPLE_MUSIC_STOREFRONT: z
      .string()
      .regex(/^[a-z]{2}$/)
      .default("us"),
    APPLE_MUSIC_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    APPLE_MUSIC_TOKEN_LIFETIME_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(15_777_000)
      .default(3600),
    APP_BASE_URL: z.url().default("http://127.0.0.1:3000"),
    APP_ENCRYPTION_KEY: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    DISCOVERY_SCHEDULER_ENABLED: booleanFlag(false),
    INITIAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
    MUSICBRAINZ_CONTACT_EMAIL: z.email().optional(),
    MUSICBRAINZ_ENABLED: booleanFlag(false),
    REDDIT_ACCESS_APPROVED: booleanFlag(false),
    REDDIT_CLIENT_ID: z.string().min(1).optional(),
    REDDIT_CLIENT_SECRET: z.string().min(1).optional(),
    REDDIT_ENABLED: booleanFlag(false),
    REDDIT_INCLUDE_COMMENTS: booleanFlag(false),
    REDDIT_INITIAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    REDDIT_INTERNAL_MAX_QPM: z.coerce.number().int().min(1).max(99).default(30),
    REDDIT_MAX_PAGES_PER_SUBREDDIT: z.coerce.number().int().min(1).max(100).default(10),
    REDDIT_SCAN_OVERLAP_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    REDDIT_USER_AGENT: z.string().min(1).optional(),
    SCAN_DETAIL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    SOUNDCLOUD_MANUAL_LINKS_ENABLED: booleanFlag(false),
    SPOTIFY_CLIENT_ID: z.string().min(1).optional(),
    SPOTIFY_CLIENT_SECRET: z.string().min(1).optional(),
    SPOTIFY_ALLOWED_PLAYLIST_ID: optionalSpotifyPlaylistId,
    SPOTIFY_ARTIST_ALBUMS_24H_LIMIT: z.coerce.number().int().min(1).max(1_000).default(80),
    SPOTIFY_ARTIST_ALBUMS_PRIORITY_RESERVE: z.coerce.number().int().min(0).max(999).default(20),
    SPOTIFY_ARTIST_ALBUMS_RESERVE_RELEASE_AFTER_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(20),
    SPOTIFY_ARTISTS_PER_BATCH: z.coerce.number().int().min(1).max(100).default(15),
    SPOTIFY_BATCH_PAUSE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
    SPOTIFY_DAILY_MAX_PAGES_PER_ARTIST: z.coerce.number().int().min(1).max(10).default(1),
    SPOTIFY_ENABLED: booleanFlag(true),
    SPOTIFY_INITIAL_MAX_PAGES_PER_ARTIST: z.coerce.number().int().min(1).max(10).default(2),
    SPOTIFY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
    SPOTIFY_MIN_REQUEST_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(10_000),
    SPOTIFY_PLAYLIST_WRITES_ENABLED: booleanFlag(false),
    SPOTIFY_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(150),
    SPOTIFY_RECONCILIATION_ARTISTS_PER_BATCH: z.coerce.number().int().min(1).max(100).default(15),
    SPOTIFY_RECONCILIATION_CYCLE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    SPOTIFY_RECONCILIATION_MAX_PAGES_PER_RUN: z.coerce.number().int().min(1).max(50).default(2),
    SPOTIFY_REDIRECT_URI: z.url().default("http://127.0.0.1:3000/api/auth/spotify/callback"),
    SPOTIFY_SCAN_DISTRIBUTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    SPOTIFY_SCHEDULER_ENABLED: booleanFlag(false),
    SPOTIFY_SCHEDULER_MAX_REQUESTS_PER_TICK: z.coerce.number().int().min(1).max(6).default(6),
    SPOTIFY_SCHEDULER_MAX_RUNTIME_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(90_000)
      .default(90_000),
    SPOTIFY_SCHEDULER_ROLLING_24H_LIMIT: z.coerce.number().int().min(593).max(10_000).default(1200),
    SPOTIFY_SCHEDULER_ROLLING_30M_LIMIT: z.coerce.number().int().min(1).max(1000).default(30),
  })
  .superRefine((value, context) => {
    if (
      value.SPOTIFY_ALLOWED_PLAYLIST_ID &&
      value.SPOTIFY_ALLOWED_PLAYLIST_ID !== spotifyAuthorizedPlaylistId
    ) {
      context.addIssue({
        code: "custom",
        message: "Spotify playlist access is restricted to the authorized Release Inbox.",
        path: ["SPOTIFY_ALLOWED_PLAYLIST_ID"],
      });
    }
    if (value.SPOTIFY_ARTIST_ALBUMS_PRIORITY_RESERVE >= value.SPOTIFY_ARTIST_ALBUMS_24H_LIMIT) {
      context.addIssue({
        code: "custom",
        message: "Spotify Artist Albums priority reserve must be below the total limit.",
        path: ["SPOTIFY_ARTIST_ALBUMS_PRIORITY_RESERVE"],
      });
    }
  });

export interface ProviderConfiguration {
  appleMusic: {
    configured: boolean;
    enabled: boolean;
    keyId?: string;
    maxRequestsPerRun: number;
    maxRuntimeMs: number;
    minRequestIntervalMs: number;
    privateKeyPath?: string;
    requestTimeoutMs: number;
    storefront: string;
    teamId?: string;
    tokenLifetimeSeconds: number;
  };
  appBaseUrl: string;
  appEncryptionKey?: string;
  databaseUrl?: string;
  discoverySchedulerEnabled: boolean;
  initialBackfillDays: number;
  musicbrainz: {
    configured: boolean;
    contactEmail?: string;
    enabled: boolean;
  };
  reddit: {
    accessApproved: boolean;
    clientId?: string;
    clientSecret?: string;
    configured: boolean;
    enabled: boolean;
    includeComments: false;
    initialBackfillDays: number;
    internalMaxQpm: number;
    maxPagesPerSubreddit: number;
    scanOverlapHours: number;
    userAgent?: string;
    userAgentValid: boolean;
  };
  scanDetailRetentionDays: number;
  soundcloudManualLinksEnabled: boolean;
  spotify: {
    allowedPlaylistId?: string;
    artistAlbums24HourLimit: number;
    artistAlbumsPriorityReserve: number;
    artistAlbumsReserveReleaseAfterHours: number;
    artistsPerBatch: number;
    batchPauseSeconds: number;
    clientId?: string;
    clientSecret?: string;
    configured: boolean;
    dailyMaxPagesPerArtist: number;
    enabled: boolean;
    initialMaxPagesPerArtist: number;
    maxConcurrency: number;
    maxRequestsPerRun: number;
    minRequestIntervalMs: number;
    playlistWritesEnabled: boolean;
    reconciliationArtistsPerBatch: number;
    reconciliationCycleDays: number;
    reconciliationMaxPagesPerRun: number;
    redirectUri: string;
    scanDistributionHours: number;
    scheduler: {
      enabled: boolean;
      maxRequestsPerTick: number;
      maxRuntimeMs: number;
      rolling24HourLimit: number;
      rolling30MinuteLimit: number;
    };
  };
}

export function loadProviderConfiguration(
  environment: Record<string, string | undefined> = process.env,
): ProviderConfiguration {
  const parsed = environmentSchema.parse(environment);
  const spotifyConfigured = Boolean(
    parsed.SPOTIFY_ENABLED &&
    parsed.SPOTIFY_CLIENT_ID &&
    parsed.SPOTIFY_CLIENT_SECRET &&
    parsed.APP_ENCRYPTION_KEY,
  );
  const redditUserAgentValid = isValidRedditUserAgent(parsed.REDDIT_USER_AGENT);
  const redditConfigured = Boolean(
    parsed.REDDIT_ENABLED &&
    parsed.REDDIT_ACCESS_APPROVED &&
    parsed.REDDIT_CLIENT_ID &&
    parsed.REDDIT_CLIENT_SECRET &&
    redditUserAgentValid,
  );
  const appleMusicConfigured = Boolean(
    parsed.APPLE_MUSIC_ENABLED &&
    parsed.APPLE_MUSIC_TEAM_ID &&
    parsed.APPLE_MUSIC_KEY_ID &&
    parsed.APPLE_MUSIC_PRIVATE_KEY_PATH,
  );

  return {
    appleMusic: {
      configured: appleMusicConfigured,
      enabled: parsed.APPLE_MUSIC_ENABLED,
      ...(parsed.APPLE_MUSIC_KEY_ID ? { keyId: parsed.APPLE_MUSIC_KEY_ID } : {}),
      maxRequestsPerRun: parsed.APPLE_MUSIC_MAX_REQUESTS_PER_RUN,
      maxRuntimeMs: parsed.APPLE_MUSIC_MAX_RUNTIME_MS,
      minRequestIntervalMs: parsed.APPLE_MUSIC_MIN_REQUEST_INTERVAL_MS,
      ...(parsed.APPLE_MUSIC_PRIVATE_KEY_PATH
        ? { privateKeyPath: parsed.APPLE_MUSIC_PRIVATE_KEY_PATH }
        : {}),
      requestTimeoutMs: parsed.APPLE_MUSIC_REQUEST_TIMEOUT_MS,
      storefront: parsed.APPLE_MUSIC_STOREFRONT,
      ...(parsed.APPLE_MUSIC_TEAM_ID ? { teamId: parsed.APPLE_MUSIC_TEAM_ID } : {}),
      tokenLifetimeSeconds: parsed.APPLE_MUSIC_TOKEN_LIFETIME_SECONDS,
    },
    appBaseUrl: parsed.APP_BASE_URL,
    ...(parsed.APP_ENCRYPTION_KEY ? { appEncryptionKey: parsed.APP_ENCRYPTION_KEY } : {}),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    discoverySchedulerEnabled: parsed.DISCOVERY_SCHEDULER_ENABLED,
    initialBackfillDays: parsed.INITIAL_BACKFILL_DAYS,
    musicbrainz: {
      configured: Boolean(parsed.MUSICBRAINZ_ENABLED && parsed.MUSICBRAINZ_CONTACT_EMAIL),
      ...(parsed.MUSICBRAINZ_CONTACT_EMAIL
        ? { contactEmail: parsed.MUSICBRAINZ_CONTACT_EMAIL }
        : {}),
      enabled: parsed.MUSICBRAINZ_ENABLED,
    },
    reddit: {
      accessApproved: parsed.REDDIT_ACCESS_APPROVED,
      ...(parsed.REDDIT_CLIENT_ID ? { clientId: parsed.REDDIT_CLIENT_ID } : {}),
      ...(parsed.REDDIT_CLIENT_SECRET ? { clientSecret: parsed.REDDIT_CLIENT_SECRET } : {}),
      configured: redditConfigured,
      enabled: parsed.REDDIT_ENABLED,
      includeComments: false,
      initialBackfillDays: parsed.REDDIT_INITIAL_BACKFILL_DAYS,
      internalMaxQpm: parsed.REDDIT_INTERNAL_MAX_QPM,
      maxPagesPerSubreddit: parsed.REDDIT_MAX_PAGES_PER_SUBREDDIT,
      scanOverlapHours: parsed.REDDIT_SCAN_OVERLAP_HOURS,
      ...(parsed.REDDIT_USER_AGENT ? { userAgent: parsed.REDDIT_USER_AGENT } : {}),
      userAgentValid: redditUserAgentValid,
    },
    scanDetailRetentionDays: parsed.SCAN_DETAIL_RETENTION_DAYS,
    soundcloudManualLinksEnabled: parsed.SOUNDCLOUD_MANUAL_LINKS_ENABLED,
    spotify: {
      ...(parsed.SPOTIFY_ALLOWED_PLAYLIST_ID
        ? { allowedPlaylistId: parsed.SPOTIFY_ALLOWED_PLAYLIST_ID }
        : {}),
      ...(parsed.SPOTIFY_CLIENT_ID ? { clientId: parsed.SPOTIFY_CLIENT_ID } : {}),
      ...(parsed.SPOTIFY_CLIENT_SECRET ? { clientSecret: parsed.SPOTIFY_CLIENT_SECRET } : {}),
      artistAlbums24HourLimit: parsed.SPOTIFY_ARTIST_ALBUMS_24H_LIMIT,
      artistAlbumsPriorityReserve: parsed.SPOTIFY_ARTIST_ALBUMS_PRIORITY_RESERVE,
      artistAlbumsReserveReleaseAfterHours:
        parsed.SPOTIFY_ARTIST_ALBUMS_RESERVE_RELEASE_AFTER_HOURS,
      artistsPerBatch: parsed.SPOTIFY_ARTISTS_PER_BATCH,
      batchPauseSeconds: parsed.SPOTIFY_BATCH_PAUSE_SECONDS,
      configured: spotifyConfigured,
      dailyMaxPagesPerArtist: parsed.SPOTIFY_DAILY_MAX_PAGES_PER_ARTIST,
      enabled: parsed.SPOTIFY_ENABLED,
      initialMaxPagesPerArtist: parsed.SPOTIFY_INITIAL_MAX_PAGES_PER_ARTIST,
      maxConcurrency: parsed.SPOTIFY_MAX_CONCURRENCY,
      maxRequestsPerRun: parsed.SPOTIFY_MAX_REQUESTS_PER_RUN,
      minRequestIntervalMs: parsed.SPOTIFY_MIN_REQUEST_INTERVAL_MS,
      playlistWritesEnabled: parsed.SPOTIFY_PLAYLIST_WRITES_ENABLED,
      reconciliationArtistsPerBatch: parsed.SPOTIFY_RECONCILIATION_ARTISTS_PER_BATCH,
      reconciliationCycleDays: parsed.SPOTIFY_RECONCILIATION_CYCLE_DAYS,
      reconciliationMaxPagesPerRun: parsed.SPOTIFY_RECONCILIATION_MAX_PAGES_PER_RUN,
      redirectUri: parsed.SPOTIFY_REDIRECT_URI,
      scanDistributionHours: parsed.SPOTIFY_SCAN_DISTRIBUTION_HOURS,
      scheduler: {
        enabled: parsed.SPOTIFY_SCHEDULER_ENABLED,
        maxRequestsPerTick: parsed.SPOTIFY_SCHEDULER_MAX_REQUESTS_PER_TICK,
        maxRuntimeMs: parsed.SPOTIFY_SCHEDULER_MAX_RUNTIME_MS,
        rolling24HourLimit: parsed.SPOTIFY_SCHEDULER_ROLLING_24H_LIMIT,
        rolling30MinuteLimit: parsed.SPOTIFY_SCHEDULER_ROLLING_30M_LIMIT,
      },
    },
  };
}

export function isValidRedditUserAgent(value: string | undefined): boolean {
  if (!value || value.length > 200) return false;
  return /^[a-z0-9_-]+:[a-z0-9._-]+:v?[a-z0-9._-]+ \(by \/u\/[A-Za-z0-9_-]+\)$/i.test(value);
}
