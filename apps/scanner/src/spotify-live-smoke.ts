import {
  createDatabase,
  createSpotifyRequestGate,
  ensureLocalOwner,
  SpotifyTokenManager,
} from "@radar/db";
import { loadProviderConfiguration, SpotifyClient, SpotifyOAuthClient } from "@radar/providers";

export interface SpotifyLiveSmokeOptions {
  dryRun: boolean;
}

export interface SpotifyLiveSmokeSummary {
  albumLookupCompleted: boolean;
  artistReleaseCount: number;
  followedArtistCount: number;
  profileRetrieved: boolean;
  trackLookupCompleted: boolean;
}

export function parseSpotifyLiveSmokeOptions(args: string[]): SpotifyLiveSmokeOptions {
  const known = new Set(["--dry-run", "--"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`Unknown live smoke option: ${unknown}`);
  const dryRun = args.includes("--dry-run");
  if (!dryRun) throw new Error("Choose --dry-run. Live playlist writes are unavailable.");
  return { dryRun };
}

export async function runSpotifyLiveSmoke(
  options: SpotifyLiveSmokeOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SpotifyLiveSmokeSummary> {
  const configuration = loadProviderConfiguration(environment);
  if (
    !configuration.databaseUrl ||
    !configuration.spotify.enabled ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.appEncryptionKey
  ) {
    throw new Error(
      "Live Spotify smoke test requires DATABASE_URL, APP_ENCRYPTION_KEY, Spotify enabled, and complete client credentials.",
    );
  }
  if (configuration.spotify.redirectUri !== "http://127.0.0.1:3000/api/auth/spotify/callback") {
    throw new Error("SPOTIFY_REDIRECT_URI must match the documented 127.0.0.1 callback.");
  }

  const connection = createDatabase(configuration.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const oauth = new SpotifyOAuthClient({
      clientId: configuration.spotify.clientId,
      clientSecret: configuration.spotify.clientSecret,
      redirectUri: configuration.spotify.redirectUri,
      requestGate: createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
      ),
    });
    const tokens = new SpotifyTokenManager(
      connection.db,
      userId,
      configuration.appEncryptionKey,
      oauth,
    );
    const client = new SpotifyClient({
      accessToken: () => tokens.getAccessToken(),
      onUnauthorized: () => tokens.refresh().then(() => undefined),
      requestGate: createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
      ),
    });

    await client.getCurrentUser();
    const followedArtists = await client.getFollowedArtists();
    let artistReleaseCount = 0;
    let albumLookupCompleted = false;
    let trackLookupCompleted = false;
    const firstArtist = followedArtists[0];
    if (firstArtist) {
      const releases = await client.getArtistAlbums(firstArtist.id);
      artistReleaseCount = releases.length;
      const firstRelease = releases[0];
      if (firstRelease) {
        await client.getAlbum(firstRelease.id);
        albumLookupCompleted = true;
        const tracks = await client.getAlbumTracks(firstRelease.id);
        const firstTrack = tracks[0];
        if (firstTrack) {
          await client.getTrack(firstTrack.id);
          trackLookupCompleted = true;
        }
      }
    }

    void options;
    return {
      albumLookupCompleted,
      artistReleaseCount,
      followedArtistCount: followedArtists.length,
      profileRetrieved: true,
      trackLookupCompleted,
    };
  } finally {
    await connection.client.end();
  }
}
