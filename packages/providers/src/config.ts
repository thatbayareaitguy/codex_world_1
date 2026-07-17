import { z } from "zod";
import { spotifyPlaylistIdSchema } from "./spotify-playlist-policy";

const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

const optionalSpotifyPlaylistId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  spotifyPlaylistIdSchema.optional(),
);

const environmentSchema = z.object({
  APP_BASE_URL: z.url().default("http://127.0.0.1:3000"),
  APP_ENCRYPTION_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  INITIAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
  MUSICBRAINZ_CONTACT_EMAIL: z.email().optional(),
  MUSICBRAINZ_ENABLED: booleanFlag(true),
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
  SPOTIFY_ARTISTS_PER_BATCH: z.coerce.number().int().min(1).max(100).default(15),
  SPOTIFY_BATCH_PAUSE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
  SPOTIFY_DAILY_MAX_PAGES_PER_ARTIST: z.coerce.number().int().min(1).max(10).default(1),
  SPOTIFY_ENABLED: booleanFlag(true),
  SPOTIFY_INITIAL_MAX_PAGES_PER_ARTIST: z.coerce.number().int().min(1).max(10).default(2),
  SPOTIFY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  SPOTIFY_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(5_000),
  SPOTIFY_PLAYLIST_WRITES_ENABLED: booleanFlag(false),
  SPOTIFY_RECONCILIATION_MAX_PAGES_PER_ARTIST: z.coerce.number().int().min(1).max(50).default(10),
  SPOTIFY_REDIRECT_URI: z.url().default("http://127.0.0.1:3000/api/auth/spotify/callback"),
  SPOTIFY_SCAN_DISTRIBUTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export interface ProviderConfiguration {
  appBaseUrl: string;
  appEncryptionKey?: string;
  databaseUrl?: string;
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
    artistsPerBatch: number;
    batchPauseSeconds: number;
    clientId?: string;
    clientSecret?: string;
    configured: boolean;
    dailyMaxPagesPerArtist: number;
    enabled: boolean;
    initialMaxPagesPerArtist: number;
    maxConcurrency: number;
    minRequestIntervalMs: number;
    playlistWritesEnabled: boolean;
    reconciliationMaxPagesPerArtist: number;
    redirectUri: string;
    scanDistributionHours: number;
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

  return {
    appBaseUrl: parsed.APP_BASE_URL,
    ...(parsed.APP_ENCRYPTION_KEY ? { appEncryptionKey: parsed.APP_ENCRYPTION_KEY } : {}),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
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
      artistsPerBatch: parsed.SPOTIFY_ARTISTS_PER_BATCH,
      batchPauseSeconds: parsed.SPOTIFY_BATCH_PAUSE_SECONDS,
      configured: spotifyConfigured,
      dailyMaxPagesPerArtist: parsed.SPOTIFY_DAILY_MAX_PAGES_PER_ARTIST,
      enabled: parsed.SPOTIFY_ENABLED,
      initialMaxPagesPerArtist: parsed.SPOTIFY_INITIAL_MAX_PAGES_PER_ARTIST,
      maxConcurrency: parsed.SPOTIFY_MAX_CONCURRENCY,
      minRequestIntervalMs: parsed.SPOTIFY_MIN_REQUEST_INTERVAL_MS,
      playlistWritesEnabled: parsed.SPOTIFY_PLAYLIST_WRITES_ENABLED,
      reconciliationMaxPagesPerArtist: parsed.SPOTIFY_RECONCILIATION_MAX_PAGES_PER_ARTIST,
      redirectUri: parsed.SPOTIFY_REDIRECT_URI,
      scanDistributionHours: parsed.SPOTIFY_SCAN_DISTRIBUTION_HOURS,
    },
  };
}

export function isValidRedditUserAgent(value: string | undefined): boolean {
  if (!value || value.length > 200) return false;
  return /^[a-z0-9_-]+:[a-z0-9._-]+:v?[a-z0-9._-]+ \(by \/u\/[A-Za-z0-9_-]+\)$/i.test(value);
}
