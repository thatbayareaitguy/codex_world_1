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
  addedById?: string;
  albumId?: string;
  albumTitle?: string;
  artistNames?: string[];
  discNumber?: number;
  position: number;
  releaseDate?: string;
  trackId: string | null;
  trackNumber?: number;
  title?: string;
}

export interface SpotifyPlaylistReorderMove {
  insertBefore: number;
  rangeLength: number;
  rangeStart: number;
  trackIds: Array<string | null>;
}

export interface SpotifyPlaylistReleaseDateOrderPlan {
  desiredItems: SpotifyPlaylistSnapshotItem[];
  moves: SpotifyPlaylistReorderMove[];
  unknownDateItems: number;
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
  reorderMoves: SpotifyPlaylistReorderMove[];
  skips: SpotifyPlaylistExportSkip[];
  orderedItems: SpotifyPlaylistSnapshotItem[];
  unrelatedItems: SpotifyPlaylistUnrelatedItem[];
}

export type SpotifyPlaylistExportOrderingPolicy =
  "canonical" | "discovery_inbox" | "release_date_custom_order";

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
  orderingPolicy: SpotifyPlaylistExportOrderingPolicy = "release_date_custom_order",
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

  const currentItems = playlistItems.slice().sort((left, right) => left.position - right.position);
  const orderedPlaylist = currentItems.map((item) => item.trackId);
  const occurrences = new Map<string, number>();
  for (const trackId of orderedPlaylist) {
    if (trackId) occurrences.set(trackId, (occurrences.get(trackId) ?? 0) + 1);
  }
  const existingDuplicateTrackIds = [...occurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([trackId]) => trackId)
    .sort();

  const missingCandidates: SpotifyPlaylistExportCandidate[] = [];
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

    missingCandidates.push(candidate);
  }

  const combinedItems = [
    ...currentItems,
    ...missingCandidates.map((candidate, index) =>
      snapshotFromCandidate(candidate, currentItems.length + index),
    ),
  ];
  const decorated = buildDecoratedReleaseDateOrder(combinedItems);
  const currentKeys = decorated.original.slice(0, currentItems.length).map((item) => item.key);
  const additionByKey = new Map(
    decorated.original.slice(currentItems.length).map((item, index) => [
      item.key,
      {
        candidate: missingCandidates[index]!,
        desiredOrdinal: desired.indexOf(missingCandidates[index]!),
      },
    ]),
  );
  const workingKeys = [...currentKeys];
  const additions: SpotifyPlaylistExportAddition[] = [];
  for (let targetIndex = 0; targetIndex < decorated.desired.length; targetIndex += 1) {
    const target = decorated.desired[targetIndex]!;
    if (!additionByKey.has(target.key) || workingKeys.includes(target.key)) continue;
    const group = [target];
    while (targetIndex + group.length < decorated.desired.length) {
      const next = decorated.desired[targetIndex + group.length]!;
      if (!additionByKey.has(next.key) || workingKeys.includes(next.key)) break;
      group.push(next);
    }
    const nextExisting = decorated.desired
      .slice(targetIndex + group.length)
      .find((item) => workingKeys.includes(item.key));
    const position = nextExisting ? workingKeys.indexOf(nextExisting.key) : workingKeys.length;
    workingKeys.splice(position, 0, ...group.map((item) => item.key));
    for (const [offset, item] of group.entries()) {
      const addition = additionByKey.get(item.key)!;
      additions.push({
        ...addition.candidate,
        desiredOrdinal: addition.desiredOrdinal,
        position: position + offset,
        reason: "missing_from_playlist",
      });
    }
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

  const reorderMoves = planMovesFromKeys(
    workingKeys,
    decorated.desired.map((item) => item.key),
    decorated,
  );
  const orderedItems = decorated.desired.map((item, position) => ({ ...item.item, position }));
  if (orderingPolicy === "discovery_inbox") {
    const additions = missingCandidates.map((candidate, position) => ({
      ...candidate,
      desiredOrdinal: desired.indexOf(candidate),
      position,
      reason: "missing_from_playlist" as const,
    }));
    const orderedItems = [
      ...missingCandidates.map((candidate, position) => snapshotFromCandidate(candidate, position)),
      ...currentItems.map((item, index) => ({
        ...item,
        position: missingCandidates.length + index,
      })),
    ];
    return {
      additions,
      alreadyPresent,
      desired,
      existingDuplicateTrackIds,
      finalTrackIds: orderedItems.map((item) => item.trackId),
      orderingConflicts,
      orderedItems,
      reorderMoves: [],
      releaseGroupingConflicts,
      skips,
      unrelatedItems,
    };
  }
  return {
    additions,
    alreadyPresent,
    desired,
    existingDuplicateTrackIds,
    finalTrackIds: orderedItems.map((item) => item.trackId),
    orderingConflicts,
    orderedItems,
    reorderMoves,
    releaseGroupingConflicts,
    skips,
    unrelatedItems,
  };
}

export function planSpotifyPlaylistReleaseDateOrder(
  playlistItems: readonly SpotifyPlaylistSnapshotItem[],
): SpotifyPlaylistReleaseDateOrderPlan {
  const ordered = playlistItems.slice().sort((left, right) => left.position - right.position);
  const decorated = buildDecoratedReleaseDateOrder(ordered);
  return {
    desiredItems: decorated.desired.map((item, position) => ({ ...item.item, position })),
    moves: planMovesFromKeys(
      decorated.original.map((item) => item.key),
      decorated.desired.map((item) => item.key),
      decorated,
    ),
    unknownDateItems: ordered.filter((item) => !normalizedReleaseDate(item.releaseDate)).length,
  };
}

export function applySpotifyPlaylistReorderMove(
  playlistItems: readonly SpotifyPlaylistSnapshotItem[],
  move: Pick<SpotifyPlaylistReorderMove, "insertBefore" | "rangeLength" | "rangeStart">,
): SpotifyPlaylistSnapshotItem[] {
  if (
    !Number.isInteger(move.rangeStart) ||
    move.rangeStart < 0 ||
    !Number.isInteger(move.rangeLength) ||
    move.rangeLength < 1 ||
    move.rangeStart + move.rangeLength > playlistItems.length ||
    !Number.isInteger(move.insertBefore) ||
    move.insertBefore < 0 ||
    move.insertBefore > playlistItems.length
  ) {
    throw new Error("Spotify playlist reorder move is outside the playlist bounds.");
  }
  const result = playlistItems.slice().sort((left, right) => left.position - right.position);
  const moved = result.splice(move.rangeStart, move.rangeLength);
  const insertionIndex =
    move.insertBefore > move.rangeStart ? move.insertBefore - move.rangeLength : move.insertBefore;
  result.splice(insertionIndex, 0, ...moved);
  return result.map((item, position) => ({ ...item, position }));
}

interface DecoratedPlaylistItem {
  item: SpotifyPlaylistSnapshotItem;
  key: string;
}

function buildDecoratedReleaseDateOrder(items: readonly SpotifyPlaylistSnapshotItem[]): {
  desired: DecoratedPlaylistItem[];
  original: DecoratedPlaylistItem[];
} {
  const occurrences = new Map<string, number>();
  const original = items.map((item) => {
    const base = item.trackId
      ? `track:${item.trackId}`
      : `unknown:${item.albumId ?? ""}:${item.title ?? ""}:${item.addedAt ?? ""}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { item, key: `${base}#${occurrence}` };
  });
  const groups = new Map<string, DecoratedPlaylistItem[]>();
  for (const item of original) {
    const groupKey = item.item.albumId ? `album:${item.item.albumId}` : `item:${item.key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  const desired = [...groups.entries()]
    .sort(([leftKey, leftItems], [rightKey, rightItems]) =>
      compareReleaseGroups(leftKey, leftItems, rightKey, rightItems),
    )
    .flatMap(([, group]) => group.slice().sort(compareReleaseTracks));
  return { desired, original };
}

function compareReleaseGroups(
  leftKey: string,
  left: readonly DecoratedPlaylistItem[],
  rightKey: string,
  right: readonly DecoratedPlaylistItem[],
): number {
  const leftDate = releaseGroupDate(left);
  const rightDate = releaseGroupDate(right);
  if (leftDate && !rightDate) return -1;
  if (!leftDate && rightDate) return 1;
  return (
    (leftDate && rightDate ? rightDate.localeCompare(leftDate) : 0) ||
    (left[0]?.item.albumTitle ?? "").localeCompare(right[0]?.item.albumTitle ?? "", "en-US") ||
    leftKey.localeCompare(rightKey, "en-US")
  );
}

function compareReleaseTracks(left: DecoratedPlaylistItem, right: DecoratedPlaylistItem): number {
  return (
    (left.item.discNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.item.discNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.item.trackNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.item.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.item.title ?? "").localeCompare(right.item.title ?? "", "en-US") ||
    (left.item.trackId ?? "").localeCompare(right.item.trackId ?? "", "en-US") ||
    left.key.localeCompare(right.key, "en-US")
  );
}

function releaseGroupDate(items: readonly DecoratedPlaylistItem[]): string | null {
  return (
    items
      .map((item) => normalizedReleaseDate(item.item.releaseDate))
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function normalizedReleaseDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const month = match[2] ?? "00";
  const day = match[3] ?? "00";
  if (Number(month) > 12 || Number(day) > 31) return null;
  return `${match[1]}-${month}-${day}`;
}

function snapshotFromCandidate(
  candidate: SpotifyPlaylistExportCandidate,
  position: number,
): SpotifyPlaylistSnapshotItem {
  return {
    albumId: candidate.providerReleaseId ?? candidate.releaseId,
    albumTitle: candidate.releaseTitle,
    discNumber: candidate.discNumber,
    position,
    releaseDate: candidate.releaseDate,
    trackId: candidate.providerTrackId ?? null,
    trackNumber: candidate.trackNumber,
    title: candidate.title,
  };
}

function planMovesFromKeys(
  currentKeys: readonly string[],
  desiredKeys: readonly string[],
  decorated: { desired: DecoratedPlaylistItem[] },
): SpotifyPlaylistReorderMove[] {
  if (currentKeys.length !== desiredKeys.length) {
    throw new Error("Spotify playlist reorder planning requires the same item count.");
  }
  const working = [...currentKeys];
  const trackIdByKey = new Map(decorated.desired.map((item) => [item.key, item.item.trackId]));
  const moves: SpotifyPlaylistReorderMove[] = [];
  for (let targetIndex = 0; targetIndex < desiredKeys.length; targetIndex += 1) {
    if (working[targetIndex] === desiredKeys[targetIndex]) continue;
    const rangeStart = working.indexOf(desiredKeys[targetIndex]!, targetIndex + 1);
    if (rangeStart < 0) throw new Error("Spotify playlist reorder target is not a permutation.");
    let rangeLength = 1;
    while (
      rangeStart + rangeLength < working.length &&
      targetIndex + rangeLength < desiredKeys.length &&
      working[rangeStart + rangeLength] === desiredKeys[targetIndex + rangeLength]
    ) {
      rangeLength += 1;
    }
    const block = working.splice(rangeStart, rangeLength);
    working.splice(targetIndex, 0, ...block);
    moves.push({
      insertBefore: targetIndex,
      rangeLength,
      rangeStart,
      trackIds: block.map((key) => trackIdByKey.get(key) ?? null),
    });
  }
  if (working.some((key, index) => key !== desiredKeys[index])) {
    throw new Error("Spotify playlist reorder planner did not reach the requested order.");
  }
  return moves;
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
