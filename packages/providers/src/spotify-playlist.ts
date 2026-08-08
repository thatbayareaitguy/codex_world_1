import type { FeedState, ReleaseType } from "@radar/core";
import type { PlaylistItemInput } from "./contracts";
import { spotifyTrackIdSchema } from "./spotify-playlist-policy";

export interface PlaylistSyncPlan {
  alreadyPresent: string[];
  rejected: Array<{ providerTrackId: string; reason: string }>;
  toAdd: string[];
}

export interface SpotifyPlaylistExportCandidate {
  confidence?: number;
  discNumber: number;
  feedItemId: string;
  feedState: FeedState;
  followedArtist: boolean;
  manuallyConfirmed: boolean;
  matchRule?: string;
  providerTrackId?: string;
  providerUrl?: string;
  providerReleaseId?: string;
  releaseDate: string;
  releaseId: string;
  releaseTitle: string;
  releaseType: ReleaseType;
  title: string;
  trackId: string;
  trackNumber: number;
}

export interface SpotifyPlaylistSnapshotItem {
  addedAt?: string;
  albumId?: string;
  albumTitle?: string;
  artistNames?: string[];
  position: number;
  releaseDate?: string;
  trackId: string | null;
  title?: string;
}

export interface SpotifyPlaylistUnrelatedItem extends SpotifyPlaylistSnapshotItem {
  reason: "not_in_export_set";
}

export type SpotifyPlaylistExportSkipReason =
  | "duplicate_recording_appearance"
  | "feed_dismissed"
  | "malformed_spotify_track_id"
  | "missing_spotify_match"
  | "needs_review"
  | "not_followed_artist"
  | "uncertain_spotify_match";

export interface SpotifyPlaylistExportSkip {
  feedItemId: string;
  providerTrackId?: string;
  reason: SpotifyPlaylistExportSkipReason;
  title: string;
  trackId: string;
}

export interface SpotifyPlaylistExportAddition extends SpotifyPlaylistExportCandidate {
  desiredOrdinal: number;
  position: number;
  reason: "missing_from_playlist";
}

export interface SpotifyPlaylistAlreadyPresent extends SpotifyPlaylistExportCandidate {
  appManaged: boolean;
  desiredOrdinal: number;
  position: number;
}

export interface SpotifyPlaylistExportPlan {
  additions: SpotifyPlaylistExportAddition[];
  alreadyPresent: SpotifyPlaylistAlreadyPresent[];
  desired: SpotifyPlaylistExportCandidate[];
  existingDuplicateTrackIds: string[];
  finalTrackIds: Array<string | null>;
  orderingConflicts: Array<{
    earlierTrackId: string;
    earlierPosition: number;
    laterTrackId: string;
    laterPosition: number;
  }>;
  releaseGroupingConflicts: Array<{
    positions: number[];
    releaseId: string;
    releaseTitle: string;
  }>;
  skips: SpotifyPlaylistExportSkip[];
  unrelatedItems: SpotifyPlaylistUnrelatedItem[];
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

    const exact = isExactSpotifyIdentity(item.matchRule, item.confidence);
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

export function planSpotifyPlaylistExport(
  candidates: readonly SpotifyPlaylistExportCandidate[],
  playlistItems: readonly SpotifyPlaylistSnapshotItem[],
  appManagedTrackIds: ReadonlySet<string>,
  options: { additionsAtTop?: boolean } = {},
): SpotifyPlaylistExportPlan {
  const skips: SpotifyPlaylistExportSkip[] = [];
  const eligible = candidates
    .slice()
    .sort(compareSpotifyPlaylistCandidates)
    .filter((candidate) => {
      const reason = spotifyPlaylistExportSkipReason(candidate);
      if (!reason) return true;
      skips.push(toSkip(candidate, reason));
      return false;
    });

  const desired: SpotifyPlaylistExportCandidate[] = [];
  const desiredTrackIds = new Set<string>();
  for (const candidate of eligible) {
    const providerTrackId = candidate.providerTrackId!;
    if (desiredTrackIds.has(providerTrackId)) {
      skips.push(toSkip(candidate, "duplicate_recording_appearance"));
      continue;
    }
    desiredTrackIds.add(providerTrackId);
    desired.push(candidate);
  }

  const orderedPlaylist = playlistItems
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((item) => item.trackId);
  const occurrences = new Map<string, number>();
  for (const trackId of orderedPlaylist) {
    if (trackId) occurrences.set(trackId, (occurrences.get(trackId) ?? 0) + 1);
  }
  const existingDuplicateTrackIds = [...occurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([trackId]) => trackId)
    .sort();

  const additions: SpotifyPlaylistExportAddition[] = [];
  const alreadyPresent: SpotifyPlaylistAlreadyPresent[] = [];
  for (const [desiredOrdinal, candidate] of desired.entries()) {
    const providerTrackId = candidate.providerTrackId!;
    const existingPosition = orderedPlaylist.indexOf(providerTrackId);
    if (existingPosition >= 0) {
      alreadyPresent.push({
        ...candidate,
        appManaged: appManagedTrackIds.has(providerTrackId),
        desiredOrdinal,
        position: existingPosition,
      });
      continue;
    }

    const nextExisting = desired
      .slice(desiredOrdinal + 1)
      .map((item) => item.providerTrackId!)
      .find((trackId) => orderedPlaylist.includes(trackId));
    let position = nextExisting ? orderedPlaylist.indexOf(nextExisting) : -1;
    if (position < 0) {
      const previousExisting = desired
        .slice(0, desiredOrdinal)
        .reverse()
        .map((item) => item.providerTrackId!)
        .find((trackId) => orderedPlaylist.includes(trackId));
      position = previousExisting ? orderedPlaylist.lastIndexOf(previousExisting) + 1 : 0;
    }
    orderedPlaylist.splice(position, 0, providerTrackId);
    additions.push({
      ...candidate,
      desiredOrdinal,
      position,
      reason: "missing_from_playlist",
    });
  }

  const existingDesired = desired
    .map((candidate) => ({
      providerTrackId: candidate.providerTrackId!,
      position: playlistItems.find((item) => item.trackId === candidate.providerTrackId)?.position,
    }))
    .filter(
      (item): item is { providerTrackId: string; position: number } => item.position !== undefined,
    );
  const orderingConflicts: SpotifyPlaylistExportPlan["orderingConflicts"] = [];
  for (let index = 1; index < existingDesired.length; index += 1) {
    const earlier = existingDesired[index - 1]!;
    const later = existingDesired[index]!;
    if (earlier.position <= later.position) continue;
    orderingConflicts.push({
      earlierPosition: earlier.position,
      earlierTrackId: earlier.providerTrackId,
      laterPosition: later.position,
      laterTrackId: later.providerTrackId,
    });
  }

  const releaseGroupingConflicts: SpotifyPlaylistExportPlan["releaseGroupingConflicts"] = [];
  const desiredByRelease = new Map<string, SpotifyPlaylistExportCandidate[]>();
  for (const candidate of desired) {
    const group = desiredByRelease.get(candidate.releaseId) ?? [];
    group.push(candidate);
    desiredByRelease.set(candidate.releaseId, group);
  }
  for (const [releaseId, releaseCandidates] of desiredByRelease) {
    const exactProviderReleaseId = releaseCandidates.find(
      (candidate) => candidate.providerReleaseId,
    )?.providerReleaseId;
    const desiredPositions = releaseCandidates
      .map(
        (candidate) =>
          playlistItems.find((item) => item.trackId === candidate.providerTrackId)?.position,
      )
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => left - right);
    if (desiredPositions.length < 2) continue;
    const positions = playlistItems
      .filter(
        (item) =>
          desiredPositions.includes(item.position) ||
          (exactProviderReleaseId !== undefined && item.albumId === exactProviderReleaseId),
      )
      .map((item) => item.position)
      .sort((left, right) => left - right);
    const contiguous = positions.at(-1)! - positions[0]! + 1 === positions.length;
    if (!contiguous) {
      releaseGroupingConflicts.push({
        positions,
        releaseId,
        releaseTitle: releaseCandidates[0]!.releaseTitle,
      });
    }
  }

  const unrelatedItems = playlistItems
    .filter((item) => item.trackId === null || !desiredTrackIds.has(item.trackId))
    .map((item) => ({ ...item, reason: "not_in_export_set" as const }));

  const plannedAdditions = options.additionsAtTop
    ? additions.map((addition, position) => ({ ...addition, position }))
    : additions;
  const finalTrackIds = options.additionsAtTop
    ? [
        ...plannedAdditions.map((addition) => addition.providerTrackId!),
        ...playlistItems
          .slice()
          .sort((left, right) => left.position - right.position)
          .map((item) => item.trackId),
      ]
    : orderedPlaylist;
  return {
    additions: plannedAdditions,
    alreadyPresent,
    desired,
    existingDuplicateTrackIds,
    finalTrackIds,
    orderingConflicts,
    releaseGroupingConflicts,
    skips,
    unrelatedItems,
  };
}

export function groupSpotifyPlaylistAdditions(
  additions: readonly SpotifyPlaylistExportAddition[],
  maximumItems = 100,
): SpotifyPlaylistExportAddition[][] {
  if (!Number.isInteger(maximumItems) || maximumItems < 1 || maximumItems > 100) {
    throw new Error("Spotify playlist addition groups must contain from 1 to 100 items.");
  }
  const groups: SpotifyPlaylistExportAddition[][] = [];
  for (const addition of additions) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (
      current &&
      previous &&
      current.length < maximumItems &&
      addition.position === previous.position + 1
    ) {
      current.push(addition);
    } else {
      groups.push([addition]);
    }
  }
  return groups;
}

export function isExactSpotifyIdentity(matchRule: string, confidence: number): boolean {
  return confidence >= 0.98 && (matchRule === "new_canonical" || matchRule.startsWith("exact_"));
}

function spotifyPlaylistExportSkipReason(
  candidate: SpotifyPlaylistExportCandidate,
): SpotifyPlaylistExportSkipReason | null {
  if (!candidate.followedArtist) return "not_followed_artist";
  if (candidate.feedState === "dismissed") return "feed_dismissed";
  if (!candidate.providerTrackId) return "missing_spotify_match";
  if (!spotifyTrackIdSchema.safeParse(candidate.providerTrackId).success) {
    return "malformed_spotify_track_id";
  }
  if (candidate.feedState === "needs_review" && !candidate.manuallyConfirmed) {
    return "needs_review";
  }
  if (
    !candidate.manuallyConfirmed &&
    !isExactSpotifyIdentity(candidate.matchRule ?? "", candidate.confidence ?? 0)
  ) {
    return "uncertain_spotify_match";
  }
  return null;
}

function compareSpotifyPlaylistCandidates(
  left: SpotifyPlaylistExportCandidate,
  right: SpotifyPlaylistExportCandidate,
): number {
  return (
    right.releaseDate.localeCompare(left.releaseDate) ||
    left.releaseId.localeCompare(right.releaseId) ||
    left.discNumber - right.discNumber ||
    left.trackNumber - right.trackNumber ||
    left.title.localeCompare(right.title, "en-US") ||
    left.trackId.localeCompare(right.trackId)
  );
}

function toSkip(
  candidate: SpotifyPlaylistExportCandidate,
  reason: SpotifyPlaylistExportSkipReason,
): SpotifyPlaylistExportSkip {
  return {
    feedItemId: candidate.feedItemId,
    ...(candidate.providerTrackId ? { providerTrackId: candidate.providerTrackId } : {}),
    reason,
    title: candidate.title,
    trackId: candidate.trackId,
  };
}
