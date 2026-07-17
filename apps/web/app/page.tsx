import { feedFixtures, mockScanFeedFixture } from "@radar/testing";
import { abbreviateSpotifyPlaylistId, loadProviderConfiguration } from "@radar/providers";
import { RadarShell } from "./radar-shell";
import { loadDatabaseFeed } from "../lib/feed-server";
import { loadDatabaseWatchlist } from "../lib/watchlist-server";
import type { WatchlistArtistViewModel } from "../lib/watchlist-types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const configuration = loadProviderConfiguration();
  const e2eMockMode = process.env.RADAR_E2E_MOCK_MODE === "true";
  let initialItems = feedFixtures;
  let feedMode: "database" | "error" | "mock" = "mock";
  let initialArtists: WatchlistArtistViewModel[] = [];
  let watchlistMode: "database" | "error" | "mock" = "mock";
  if (configuration.databaseUrl && !e2eMockMode) {
    try {
      initialItems = await loadDatabaseFeed(configuration.databaseUrl);
      feedMode = "database";
    } catch {
      feedMode = "error";
    }
    try {
      initialArtists = await loadDatabaseWatchlist(configuration.databaseUrl);
      watchlistMode = "database";
    } catch {
      watchlistMode = "error";
    }
  }
  return (
    <RadarShell
      feedMode={feedMode}
      initialArtists={initialArtists}
      initialItems={initialItems}
      providerConfiguration={{
        databaseConfigured: Boolean(configuration.databaseUrl),
        musicbrainz: {
          configured: configuration.musicbrainz.configured,
          enabled: configuration.musicbrainz.enabled,
        },
        soundcloudManualLinksEnabled: configuration.soundcloudManualLinksEnabled,
        spotify: {
          allowedPlaylistConfigured: Boolean(configuration.spotify.allowedPlaylistId),
          ...(configuration.spotify.allowedPlaylistId
            ? {
                allowedPlaylistIdAbbreviated: abbreviateSpotifyPlaylistId(
                  configuration.spotify.allowedPlaylistId,
                ),
              }
            : {}),
          configured: configuration.spotify.configured,
          enabled: configuration.spotify.enabled,
          playlistWritesEnabled: configuration.spotify.playlistWritesEnabled,
        },
      }}
      scannedItem={mockScanFeedFixture}
      watchlistMode={watchlistMode}
    />
  );
}
