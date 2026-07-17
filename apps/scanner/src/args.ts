import { providerNames, type ProviderName } from "@radar/core";

export interface ScannerOptions {
  dryRun: boolean;
  artistId?: string;
  full: boolean;
  provider?: ProviderName;
  source?: string;
  since?: string;
}

export function parseArgs(args: string[]): ScannerOptions {
  const options: ScannerOptions = { dryRun: false, full: false };
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
      if (!value || !providerNames.includes(value as ProviderName)) {
        throw new Error(`--provider must be one of: ${providerNames.join(", ")}`);
      }
      options.provider = value as ProviderName;
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
