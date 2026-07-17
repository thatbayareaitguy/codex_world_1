import type { PlaylistItemInput } from "./contracts";

export interface PlaylistSyncPlan {
  alreadyPresent: string[];
  rejected: Array<{ providerTrackId: string; reason: string }>;
  toAdd: string[];
}

export function planSpotifyPlaylistSync(
  items: PlaylistItemInput[],
  existingTrackIds: ReadonlySet<string>,
): PlaylistSyncPlan {
  const seen = new Set<string>();
  const plan: PlaylistSyncPlan = { alreadyPresent: [], rejected: [], toAdd: [] };
  for (const item of items) {
    if (seen.has(item.providerTrackId)) continue;
    seen.add(item.providerTrackId);

    const exact = item.matchRule.startsWith("exact_") && item.confidence >= 0.98;
    if (!exact && !item.manuallyConfirmed) {
      plan.rejected.push({
        providerTrackId: item.providerTrackId,
        reason: "Only exact or manually confirmed matches may be exported",
      });
      continue;
    }
    if (existingTrackIds.has(item.providerTrackId)) {
      plan.alreadyPresent.push(item.providerTrackId);
      continue;
    }
    plan.toAdd.push(item.providerTrackId);
  }
  return plan;
}
