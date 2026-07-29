import { resolve } from "node:path";
import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { loadLocalEnvironment } from "./local-env";
import { writeOfflineArtifactIfChanged } from "./itunes-pilot-offline-artifacts";
import {
  evaluateStoredItunesPilot,
  serializeOfflineEvaluation,
} from "./itunes-pilot-offline-evaluator";

async function main(): Promise<void> {
  const environment = loadLocalEnvironment();
  const configuration = loadProviderConfiguration(environment);
  assertOfflineConfiguration(configuration);
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const result = await evaluateStoredItunesPilot(connection.db);
    const destinations = {
      evaluation: resolve("docs/itunes-pilot-offline-evaluation.json"),
      identity: resolve("docs/itunes-pilot-identity-provenance.csv"),
      matches: resolve("docs/itunes-pilot-match-review.csv"),
    };
    await Promise.all([
      writeOfflineArtifactIfChanged(
        destinations.evaluation,
        serializeOfflineEvaluation(result.evaluation),
      ),
      writeOfflineArtifactIfChanged(destinations.identity, result.identityProvenanceCsv),
      writeOfflineArtifactIfChanged(destinations.matches, result.matchReviewCsv),
    ]);
    console.log(
      JSON.stringify(
        {
          destinations,
          evidenceConfirmedMappings: result.evaluation.identityProvenance.length,
          matchReviewRows: result.matchReviewCsv.trim().split("\n").length - 1,
          networkRequestsMade: 0,
          windows: result.evaluation.windows.map((window) => ({
            days: window.days,
            spotifyQueries: window.fallback.totalSpotifyQueries,
            spotifyQueriesAvoided: window.fallback.spotifyQueriesAvoided,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await connection.client.end();
  }
}

function assertOfflineConfiguration(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): void {
  const database = configuration.databaseUrl ? new URL(configuration.databaseUrl) : null;
  if (
    !database ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "55433" ||
    database.pathname !== "/radar_itunes"
  ) {
    throw new Error("Offline evaluation requires the isolated radar_itunes database.");
  }
  if (
    configuration.itunes.enabled ||
    configuration.spotify.enabled ||
    configuration.spotify.playlistWritesEnabled ||
    configuration.musicbrainz.enabled ||
    configuration.reddit.enabled ||
    configuration.soundcloudManualLinksEnabled
  ) {
    throw new Error("Every provider must be disabled for offline iTunes evaluation.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
