import { feedFixtures, mockScanFeedFixture } from "@radar/testing";
import { loadProviderConfiguration } from "@radar/providers";
import { RadarShell } from "./radar-shell";
import { loadDatabaseFeed } from "../lib/feed-server";

export default async function HomePage() {
  const configuration = loadProviderConfiguration();
  let initialItems = feedFixtures;
  let feedMode: "database" | "error" | "mock" = "mock";
  if (configuration.databaseUrl) {
    try {
      initialItems = await loadDatabaseFeed(configuration.databaseUrl);
      feedMode = "database";
    } catch {
      feedMode = "error";
    }
  }
  return (
    <RadarShell
      feedMode={feedMode}
      initialItems={initialItems}
      providerConfiguration={{
        databaseConfigured: Boolean(configuration.databaseUrl),
        musicbrainz: {
          configured: configuration.musicbrainz.configured,
          enabled: configuration.musicbrainz.enabled,
        },
        soundcloudManualLinksEnabled: configuration.soundcloudManualLinksEnabled,
        spotify: {
          configured: configuration.spotify.configured,
          enabled: configuration.spotify.enabled,
        },
      }}
      scannedItem={mockScanFeedFixture}
    />
  );
}
