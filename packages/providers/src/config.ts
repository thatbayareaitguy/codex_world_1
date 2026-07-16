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
