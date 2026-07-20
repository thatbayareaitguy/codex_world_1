import { feedFixtures, mockScanFeedFixture } from "@radar/testing";
import { abbreviateSpotifyPlaylistId, loadProviderConfiguration } from "@radar/providers";
import { RadarShell } from "./radar-shell";
import { loadDatabaseFeedSnapshot } from "../lib/feed-server";
import { loadDatabaseWatchlist } from "../lib/watchlist-server";
import type { WatchlistArtistViewModel } from "../lib/watchlist-types";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const configuration = loadProviderConfiguration();
  const e2eMockMode = process.env.RADAR_E2E_MOCK_MODE === "true";
  const parameters = await searchParams;
  const e2eScanStatusMode = e2eMockMode && parameters["e2e-scan-status"] === "database";
  let initialItems = feedFixtures;
  let initialFeedRevision: string | null = null;
  let feedMode: "database" | "error" | "mock" = "mock";
  let initialArtists: WatchlistArtistViewModel[] = [];
  let watchlistMode: "database" | "error" | "mock" = "mock";
  if (e2eScanStatusMode) feedMode = "database";
  if (configuration.databaseUrl && !e2eMockMode) {
    try {
      const snapshot = await loadDatabaseFeedSnapshot(configuration.databaseUrl);
      initialItems = snapshot.items;
      initialFeedRevision = snapshot.revision;
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
      initialFeedRevision={initialFeedRevision}
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
          minRequestIntervalMs: configuration.spotify.minRequestIntervalMs,
          playlistWritesEnabled: configuration.spotify.playlistWritesEnabled,
        },
      }}
      scannedItem={mockScanFeedFixture}
      watchlistMode={watchlistMode}
    />
  );
}
