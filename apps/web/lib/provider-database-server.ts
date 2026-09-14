import { createDatabase, ensureLocalOwner, type RadarDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";

export async function createProviderDatabaseServerContext(): Promise<{
  close: () => Promise<void>;
  db: RadarDatabase;
  userId: string;
}> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("Database configuration is incomplete.");
  const connection = createDatabase(configuration.databaseUrl);
  return {
    close: () => connection.client.end(),
    db: connection.db,
    userId: await ensureLocalOwner(connection.db),
  };
}
