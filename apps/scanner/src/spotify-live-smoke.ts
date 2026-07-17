import { createDatabase, ensureLocalOwner, SpotifyTokenManager } from "@radar/db";
import { loadProviderConfiguration, SpotifyClient, SpotifyOAuthClient } from "@radar/providers";

export interface SpotifyLiveSmokeOptions {
  confirmTemporaryPlaylist: boolean;
  dryRun: boolean;
  playlistWrite: boolean;
}

export interface SpotifyLiveSmokeSummary {
  albumLookupCompleted: boolean;
  artistReleaseCount: number;
  followedArtistCount: number;
  playlistCreated: boolean;
  profileRetrieved: boolean;
  temporaryPlaylistCleanup: "manual_required" | "not_applicable";
  trackLookupCompleted: boolean;
}

export function parseSpotifyLiveSmokeOptions(args: string[]): SpotifyLiveSmokeOptions {
  const known = new Set(["--dry-run", "--playlist-write", "--confirm-temporary-playlist", "--"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`Unknown live smoke option: ${unknown}`);
  const playlistWrite = args.includes("--playlist-write");
  const dryRun = args.includes("--dry-run");
  const confirmTemporaryPlaylist = args.includes("--confirm-temporary-playlist");
  if (!dryRun && !playlistWrite) {
    throw new Error("Choose --dry-run or --playlist-write. Read-only dry-run is recommended.");
  }
  if (playlistWrite && !confirmTemporaryPlaylist) {
    throw new Error("Playlist-write verification requires --confirm-temporary-playlist.");
  }
  if (dryRun && playlistWrite) {
    throw new Error("Choose either --dry-run or --playlist-write, not both.");
  }
  return { confirmTemporaryPlaylist, dryRun, playlistWrite };
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

    let playlistCreated = false;
    if (options.playlistWrite) {
      await client.createPrivatePlaylist(
        `TS New Music Radar temporary live smoke ${new Date().toISOString()}`,
      );
      playlistCreated = true;
    }
    return {
      albumLookupCompleted,
      artistReleaseCount,
      followedArtistCount: followedArtists.length,
      playlistCreated,
      profileRetrieved: true,
      temporaryPlaylistCleanup: playlistCreated ? "manual_required" : "not_applicable",
      trackLookupCompleted,
    };
  } finally {
    await connection.client.end();
  }
}
