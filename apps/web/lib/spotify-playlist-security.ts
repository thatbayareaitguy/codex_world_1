import {
  assertSpotifyPlaylistWriteTarget,
  spotifyPlaylistIdSchema,
  type ProviderConfiguration,
} from "@radar/providers";
import type { NextRequest } from "next/server";

export class SpotifyPlaylistRequestBodyError extends Error {
  constructor() {
    super("Spotify playlist-write routes do not accept a request body");
    this.name = "SpotifyPlaylistRequestBodyError";
  }
}

export function configuredSpotifyPlaylistId(
  configuration: ProviderConfiguration,
): string | undefined {
  const value = configuration.spotify.allowedPlaylistId;
  return value ? spotifyPlaylistIdSchema.parse(value) : undefined;
}

export function requireSpotifyPlaylistWriteRoute(configuration: ProviderConfiguration): string {
  return assertSpotifyPlaylistWriteTarget(
    {
      ...(configuration.spotify.allowedPlaylistId
        ? { allowedPlaylistId: configuration.spotify.allowedPlaylistId }
        : {}),
      enabled: configuration.spotify.playlistWritesEnabled,
    },
    configuration.spotify.allowedPlaylistId ?? "",
  );
}

export async function assertNoPlaylistWriteRequestBody(request: NextRequest): Promise<void> {
  if ((await request.text()).trim()) {
    throw new SpotifyPlaylistRequestBodyError();
  }
}
