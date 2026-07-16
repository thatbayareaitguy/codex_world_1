import { createDatabase, ensureLocalOwner, type RadarDatabase } from "@radar/db";
import { loadProviderConfiguration, MusicBrainzClient } from "@radar/providers";

export async function createMusicBrainzServerContext(): Promise<{
  client: MusicBrainzClient;
  close: () => Promise<void>;
  db: RadarDatabase;
  userId: string;
}> {
  const config = loadProviderConfiguration();
  if (!config.musicbrainz.enabled) throw new Error("MusicBrainz is disabled");
  if (!config.musicbrainz.configured || !config.musicbrainz.contactEmail || !config.databaseUrl) {
    throw new Error("MusicBrainz or database configuration is incomplete");
  }
  const connection = createDatabase(config.databaseUrl);
  const userId = await ensureLocalOwner(connection.db);
  return {
    client: new MusicBrainzClient({ contactEmail: config.musicbrainz.contactEmail }),
    close: () => connection.client.end(),
    db: connection.db,
    userId,
  };
}
