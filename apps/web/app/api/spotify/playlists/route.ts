import {
  abbreviateSpotifyPlaylistId,
  assertOwnedNonCollaborativeSpotifyPlaylist,
  loadProviderConfiguration,
} from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";
import { configuredSpotifyPlaylistId } from "../../../../lib/spotify-playlist-security";
import { createSpotifyServerContext } from "../../../../lib/spotify-server";

export async function GET(): Promise<NextResponse> {
  try {
    const configuration = loadProviderConfiguration();
    const playlistId = configuredSpotifyPlaylistId(configuration);
    if (!playlistId) {
      return NextResponse.json({
        allowedPlaylistConfigured: false,
        playlist: null,
        writesEnabled: configuration.spotify.playlistWritesEnabled,
      });
    }
    const context = await createSpotifyServerContext();
    try {
      const [profile, playlist] = await Promise.all([
        context.client.getCurrentUser(),
        context.client.getPlaylist(playlistId),
      ]);
      assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
      return NextResponse.json({
        allowedPlaylistConfigured: true,
        playlist: {
          id: abbreviateSpotifyPlaylistId(playlist.id),
          name: playlist.name,
          collaborative: false,
          public: playlist.public,
        },
        writesEnabled: configuration.spotify.playlistWritesEnabled,
      });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to inspect the configured Spotify playlist" },
      { status: 400 },
    );
  }
}

export function POST(request: NextRequest): NextResponse {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
  } catch {
    return NextResponse.json({ error: "Playlist configuration request rejected" }, { status: 403 });
  }
  return NextResponse.json(
    {
      error:
        "Playlist creation, selection, rename, visibility changes, artwork, follow, and unfollow are unavailable",
    },
    { status: 405 },
  );
}
