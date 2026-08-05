import { z } from "zod";

export const spotifyPlaylistIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{22}$/, "Spotify playlist IDs must be 22 base62 characters");

export const spotifyTrackIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{22}$/, "Spotify track IDs must be 22 base62 characters");

export interface SpotifyPlaylistWritePolicy {
  allowedPlaylistId?: string;
  enabled: boolean;
}

export interface SpotifyPlaylistOwnershipInput {
  collaborative?: boolean | undefined;
  owner?: { account_id?: string | undefined; id?: string | undefined } | undefined;
  public: boolean | null;
}

export interface SpotifyProfileOwnershipInput {
  account_id: string;
  id: string;
}

export type SpotifyPlaylistWriteDenialCode =
  | "writes_disabled"
  | "allowed_playlist_missing"
  | "playlist_id_malformed"
  | "playlist_id_mismatch"
  | "playlist_not_owned"
  | "playlist_not_private"
  | "playlist_collaborative"
  | "track_id_malformed"
  | "playlist_addition_invalid";

export class SpotifyPlaylistWriteDeniedError extends Error {
  constructor(
    message: string,
    readonly code: SpotifyPlaylistWriteDenialCode,
  ) {
    super(message);
    this.name = "SpotifyPlaylistWriteDeniedError";
  }
}

export function assertSpotifyPlaylistWriteTarget(
  policy: SpotifyPlaylistWritePolicy,
  targetPlaylistId: string,
): string {
  if (!policy.enabled) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist writes are disabled",
      "writes_disabled",
    );
  }
  if (!policy.allowedPlaylistId) {
    throw new SpotifyPlaylistWriteDeniedError(
      "SPOTIFY_ALLOWED_PLAYLIST_ID is required for playlist writes",
      "allowed_playlist_missing",
    );
  }
  const allowed = parsePlaylistId(policy.allowedPlaylistId);
  const target = parsePlaylistId(targetPlaylistId);
  if (target !== allowed) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist write target does not match the configured playlist",
      "playlist_id_mismatch",
    );
  }
  return allowed;
}

export function assertOwnedPrivateSpotifyPlaylist(
  playlist: SpotifyPlaylistOwnershipInput,
  profile: SpotifyProfileOwnershipInput,
): void {
  const owner = playlist.owner?.account_id ?? playlist.owner?.id;
  if (owner !== profile.account_id && owner !== profile.id) {
    throw new SpotifyPlaylistWriteDeniedError(
      "The configured Spotify playlist is not owned by the connected account",
      "playlist_not_owned",
    );
  }
  if (playlist.public !== false) {
    throw new SpotifyPlaylistWriteDeniedError(
      "The configured Spotify playlist is not private",
      "playlist_not_private",
    );
  }
  if (playlist.collaborative === true) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Collaborative Spotify playlists are not permitted as write targets",
      "playlist_collaborative",
    );
  }
}

export function assertSpotifyTrackIds(trackIds: readonly string[]): void {
  for (const trackId of trackIds) {
    if (!spotifyTrackIdSchema.safeParse(trackId).success) {
      throw new SpotifyPlaylistWriteDeniedError(
        "A Spotify playlist addition contains a malformed track ID",
        "track_id_malformed",
      );
    }
  }
}

export function abbreviateSpotifyPlaylistId(value: string): string {
  const parsed = spotifyPlaylistIdSchema.parse(value);
  return `${parsed.slice(0, 4)}...${parsed.slice(-4)}`;
}

function parsePlaylistId(value: string): string {
  const result = spotifyPlaylistIdSchema.safeParse(value);
  if (!result.success) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist ID is malformed",
      "playlist_id_malformed",
    );
  }
  return result.data;
}
