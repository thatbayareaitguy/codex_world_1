import { z } from "zod";

const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

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
  SPOTIFY_ENABLED: booleanFlag(true),
  SPOTIFY_REDIRECT_URI: z.url().default("http://127.0.0.1:3000/api/auth/spotify/callback"),
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
    clientId?: string;
    clientSecret?: string;
    configured: boolean;
    enabled: boolean;
    redirectUri: string;
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
      ...(parsed.SPOTIFY_CLIENT_ID ? { clientId: parsed.SPOTIFY_CLIENT_ID } : {}),
      ...(parsed.SPOTIFY_CLIENT_SECRET ? { clientSecret: parsed.SPOTIFY_CLIENT_SECRET } : {}),
      configured: spotifyConfigured,
      enabled: parsed.SPOTIFY_ENABLED,
      redirectUri: parsed.SPOTIFY_REDIRECT_URI,
    },
  };
}

export function isValidRedditUserAgent(value: string | undefined): boolean {
  if (!value || value.length > 200) return false;
  return /^[a-z0-9_-]+:[a-z0-9._-]+:v?[a-z0-9._-]+ \(by \/u\/[A-Za-z0-9_-]+\)$/i.test(value);
}
