import type { ProviderName } from "@radar/core";
import type { ScannerOptions } from "./args";

export type ScheduledScanTriggerType =
  "apple_catchup_scheduled" | "apple_full_scheduled" | "spotify_scheduled";

export function providerScanTriggerType(
  provider: ProviderName,
  options: ScannerOptions,
  scheduledTriggerType?: ScheduledScanTriggerType,
): string {
  if (
    scheduledTriggerType &&
    ((provider === "apple_music" && scheduledTriggerType.startsWith("apple_")) ||
      (provider === "spotify" && scheduledTriggerType === "spotify_scheduled"))
  ) {
    return scheduledTriggerType;
  }
  if (provider === "apple_music") {
    if (options.artistId) return "provider_single_artist";
    if (options.artistIds?.length) return "provider_cohort";
  }
  if (options.full) return "full_reconciliation";
  return options.provider ? "provider_manual" : "manual";
}
