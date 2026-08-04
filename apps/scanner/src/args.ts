import { providerNames, type ProviderName } from "@radar/core";

export interface ScannerOptions {
  dryRun: boolean;
  artistId?: string;
  full: boolean;
  provider?: ProviderName;
  musicbrainzBatchId?: string;
  source?: string;
  spotifyBatchId?: string;
  spotifyConfirmBatch?: boolean;
  spotifyMaxPages?: number;
  spotifyMode?: "initial" | "daily" | "reconciliation";
  spotifyNewReconciliationCycle?: boolean;
  since?: string;
}

export function parseArgs(args: string[]): ScannerOptions {
  const options: ScannerOptions = {
    dryRun: false,
    full: false,
    spotifyConfirmBatch: false,
    spotifyMode: "daily",
    spotifyNewReconciliationCycle: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--artist") {
      const value = args[index + 1];
      if (!value) throw new Error("--artist requires an internal artist ID");
      options.artistId = value;
      index += 1;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      options.spotifyMode = "reconciliation";
      continue;
    }
    if (arg === "--spotify-mode") {
      const value = args[index + 1];
      if (value !== "initial" && value !== "daily" && value !== "reconciliation") {
        throw new Error("--spotify-mode must be initial, daily, or reconciliation");
      }
      options.spotifyMode = value;
      index += 1;
      continue;
    }
    if (arg === "--spotify-batch") {
      const value = args[index + 1];
      if (!value) throw new Error("--spotify-batch requires a batch ID");
      options.spotifyBatchId = value;
      index += 1;
      continue;
    }
    if (arg === "--musicbrainz-batch") {
      const value = args[index + 1];
      if (!value) throw new Error("--musicbrainz-batch requires a batch ID");
      options.musicbrainzBatchId = value;
      index += 1;
      continue;
    }
    if (arg === "--confirm-spotify-batch") {
      options.spotifyConfirmBatch = true;
      continue;
    }
    if (arg === "--spotify-max-pages") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error("--spotify-max-pages requires an integer from 1 to 50");
      }
      options.spotifyMaxPages = value;
      index += 1;
      continue;
    }
    if (arg === "--spotify-new-reconciliation-cycle") {
      options.spotifyNewReconciliationCycle = true;
      continue;
    }
    if (arg === "--since") {
      const value = args[index + 1];
      if (!value || Number.isNaN(Date.parse(value))) {
        throw new Error("--since requires a valid ISO date");
      }
      options.since = new Date(value).toISOString().slice(0, 10);
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      const normalized = value === "apple" ? "apple_music" : value;
      if (!normalized || !providerNames.includes(normalized as ProviderName)) {
        throw new Error(`--provider must be one of: ${providerNames.join(", ")}`);
      }
      options.provider = normalized as ProviderName;
      index += 1;
      continue;
    }
    if (arg === "--source") {
      const value = args[index + 1];
      if (!value) throw new Error("--source requires a configured subreddit name");
      options.source = value.replace(/^r\//i, "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
