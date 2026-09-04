import { createDatabase, sourceEvidence } from "@radar/db";
import { inArray } from "drizzle-orm";

export interface DatabaseProviderActivity {
  appleMusic: boolean;
  spotify: boolean;
}

export async function loadDatabaseProviderActivity(
  databaseUrl: string,
): Promise<DatabaseProviderActivity> {
  const connection = createDatabase(databaseUrl);
  try {
    const rows = await connection.db
      .selectDistinct({ provider: sourceEvidence.provider })
      .from(sourceEvidence)
      .where(inArray(sourceEvidence.provider, ["apple_music", "spotify"]));
    const providers = new Set(rows.map((row) => row.provider));
    return {
      appleMusic: providers.has("apple_music"),
      spotify: providers.has("spotify"),
    };
  } finally {
    await connection.client.end();
  }
}
