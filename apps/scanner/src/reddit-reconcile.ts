import { log } from "@radar/core";
import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { reconcileRedditDeletions } from "./reddit-scan";

try {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const { db, client } = createDatabase(configuration.databaseUrl);
  try {
    const result = await reconcileRedditDeletions(db, configuration);
    log("info", "reddit.reconciliation_completed", result);
  } finally {
    await client.end();
  }
} catch (error) {
  log("error", "reddit.reconciliation_failed", {
    message: error instanceof Error ? error.message : "Unknown reconciliation error",
  });
  process.exitCode = 1;
}
