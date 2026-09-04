import type { ScannerOptions } from "./args";

export function providerIdentityOverrides(
  options: ScannerOptions,
  requestedArtistIds: readonly string[],
): ReadonlyMap<string, string> {
  const entries = options.providerArtistIdentities ?? [];
  if (entries.length === 0) return new Map();
  if (requestedArtistIds.length === 0) {
    throw new Error("Provider identity overrides require an explicit internal artist cohort.");
  }

  const requested = new Set(requestedArtistIds);
  const overrides = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.artistId || !entry.providerArtistId) {
      throw new Error("Provider identity overrides require non-empty artist identifiers.");
    }
    if (!requested.has(entry.artistId)) {
      throw new Error("A provider identity override is outside the requested artist cohort.");
    }
    if (overrides.has(entry.artistId)) {
      throw new Error("A provider identity override was supplied more than once.");
    }
    overrides.set(entry.artistId, entry.providerArtistId);
  }
  if (overrides.size !== requested.size) {
    throw new Error("Provider identity overrides must cover the complete requested artist cohort.");
  }
  return overrides;
}
