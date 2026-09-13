import {
  assertOwnedNonCollaborativeSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  hasSpotifyPlaylistWriteScopes,
  planSpotifyPlaylistReleaseDateOrder,
  spotifyAuthorizedPlaylistExpectedPublic,
  spotifyAuthorizedPlaylistId,
  spotifyPlaylistIdSchema,
  SpotifyPlaylistWriteDeniedError,
  type SpotifyClient,
  type SpotifyPlaylist,
  type SpotifyPlaylistItemSnapshot,
  type SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { and, eq, isNull } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { loadVerifiedSpotifyPlaylistSnapshot } from "./spotify-playlist-cache";
import { oauthAccounts } from "./schema";

export interface SpotifyPlaylistVisibilityClient {
  getCurrentUser: SpotifyClient["getCurrentUser"];
  getPlaylist: SpotifyClient["getPlaylist"];
  getPlaylistItems: SpotifyClient["getPlaylistItems"];
  setAuthorizedPlaylistPublic: SpotifyClient["setAuthorizedPlaylistPublic"];
}

export interface SpotifyPlaylistVisibilityPreview {
  cacheHit: boolean;
  target: {
    collaborative: false;
    currentPublic: boolean | null;
    expectedPublic: true;
    id: string;
    itemCount: number;
    name: string;
    ownerVerified: true;
    snapshotId: string;
  };
  verification: {
    customOrderMovesRequired: number;
  };
}

export interface SpotifyPlaylistVisibilityExecution extends SpotifyPlaylistVisibilityPreview {
  result: {
    addedAtAndAddedByPreserved: boolean;
    artworkPreserved: boolean;
    customOrderPreserved: boolean;
    descriptionPreserved: boolean;
    itemCountAfter: number;
    itemCountBefore: number;
    itemMultisetPreserved: boolean;
    itemOrderPreserved: boolean;
    namePreserved: boolean;
    ownerPreserved: boolean;
    publicAfter: true;
    publicBefore: boolean | null;
    snapshotCacheReconciled: true;
    visibilityUpdated: boolean;
  };
}

export async function previewSpotifyPlaylistVisibility(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistVisibilityClient,
  configuredPlaylistId: string,
): Promise<SpotifyPlaylistVisibilityPreview> {
  const playlistId = requireAuthorizedPlaylistId(configuredPlaylistId);
  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist, {
    forceRefresh: true,
  });
  const order = planSpotifyPlaylistReleaseDateOrder(snapshot.items);
  return {
    cacheHit: snapshot.cacheHit,
    target: {
      collaborative: false,
      currentPublic: playlist.public,
      expectedPublic: spotifyAuthorizedPlaylistExpectedPublic,
      id: playlistId,
      itemCount: snapshot.items.length,
      name: playlist.name,
      ownerVerified: true,
      snapshotId: snapshot.playlist.snapshot_id,
    },
    verification: { customOrderMovesRequired: order.moves.length },
  };
}

export async function executeSpotifyPlaylistVisibility(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistVisibilityClient,
  input: { playlistId: string; policy: SpotifyPlaylistWritePolicy },
): Promise<SpotifyPlaylistVisibilityExecution> {
  const playlistId = assertSpotifyPlaylistWriteTarget(input.policy, input.playlistId);
  requireAuthorizedPlaylistId(playlistId);
  await requireSpotifyPlaylistWriteScopes(db, userId);

  const profile = await client.getCurrentUser();
  const before = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, before.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(before, profile);
  const beforeSnapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, before, {
    forceRefresh: true,
    policy: input.policy,
  });
  const beforeOrder = planSpotifyPlaylistReleaseDateOrder(beforeSnapshot.items);
  if (beforeOrder.moves.length > 0) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist visibility cannot change until Custom Order is verified.",
      "playlist_visibility_invalid",
    );
  }

  if (before.public !== spotifyAuthorizedPlaylistExpectedPublic) {
    await client.setAuthorizedPlaylistPublic(playlistId);
  }

  const after = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, after.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(after, profile);
  const afterSnapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, after, {
    forceRefresh: true,
    policy: input.policy,
  });
  const verification = verifyVisibilityChange(
    before,
    after,
    beforeSnapshot.items,
    afterSnapshot.items,
  );
  if (!verification.valid) {
    throw new SpotifyPlaylistWriteDeniedError(
      `Spotify playlist visibility verification failed: ${verification.failures.join(", ")}`,
      "playlist_visibility_invalid",
    );
  }

  return {
    cacheHit: beforeSnapshot.cacheHit,
    result: {
      addedAtAndAddedByPreserved: true,
      artworkPreserved: true,
      customOrderPreserved: true,
      descriptionPreserved: true,
      itemCountAfter: afterSnapshot.items.length,
      itemCountBefore: beforeSnapshot.items.length,
      itemMultisetPreserved: true,
      itemOrderPreserved: true,
      namePreserved: true,
      ownerPreserved: true,
      publicAfter: true,
      publicBefore: before.public,
      snapshotCacheReconciled: true,
      visibilityUpdated: before.public !== true,
    },
    target: {
      collaborative: false,
      currentPublic: after.public,
      expectedPublic: spotifyAuthorizedPlaylistExpectedPublic,
      id: playlistId,
      itemCount: afterSnapshot.items.length,
      name: after.name,
      ownerVerified: true,
      snapshotId: afterSnapshot.playlist.snapshot_id,
    },
    verification: { customOrderMovesRequired: 0 },
  };
}

function verifyVisibilityChange(
  before: SpotifyPlaylist,
  after: SpotifyPlaylist,
  beforeItems: readonly SpotifyPlaylistItemSnapshot[],
  afterItems: readonly SpotifyPlaylistItemSnapshot[],
): { failures: string[]; valid: boolean } {
  const failures: string[] = [];
  if (after.public !== true) failures.push("playlist is not public");
  if (after.collaborative !== false) failures.push("playlist is collaborative");
  if (before.id !== after.id) failures.push("playlist ID changed");
  if (before.name !== after.name) failures.push("playlist name changed");
  if ((before.description ?? null) !== (after.description ?? null)) {
    failures.push("playlist description changed");
  }
  if (JSON.stringify(before.images ?? []) !== JSON.stringify(after.images ?? [])) {
    failures.push("playlist artwork changed");
  }
  if (ownerIdentity(before) !== ownerIdentity(after)) failures.push("playlist owner changed");
  if (beforeItems.length !== afterItems.length) failures.push("playlist item count changed");
  if (!sameMultiset(beforeItems.map(itemIdentity), afterItems.map(itemIdentity))) {
    failures.push("playlist item multiset changed");
  }
  if (!sameOrderedList(beforeItems.map(itemIdentity), afterItems.map(itemIdentity))) {
    failures.push("playlist item order changed");
  }
  if (!sameOrderedList(beforeItems.map(addedAtIdentity), afterItems.map(addedAtIdentity))) {
    failures.push("Date Added metadata changed");
  }
  if (planSpotifyPlaylistReleaseDateOrder(afterItems).moves.length > 0) {
    failures.push("Custom Order changed");
  }
  return { failures, valid: failures.length === 0 };
}

function itemIdentity(item: SpotifyPlaylistItemSnapshot): string {
  return item.trackId ?? "<unknown>";
}

function addedAtIdentity(item: SpotifyPlaylistItemSnapshot): string {
  return `${item.trackId ?? "<unknown>"}|${item.addedAt ?? ""}|${item.addedById ?? ""}`;
}

function ownerIdentity(playlist: SpotifyPlaylist): string {
  return playlist.owner?.account_id ?? playlist.owner?.id ?? "";
}

function sameOrderedList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of right) {
    const count = counts.get(item) ?? 0;
    if (count < 1) return false;
    if (count === 1) counts.delete(item);
    else counts.set(item, count - 1);
  }
  return counts.size === 0;
}

async function requireSpotifyPlaylistWriteScopes(db: RadarDatabase, userId: string): Promise<void> {
  const account = await db.query.oauthAccounts.findFirst({
    columns: { scopes: true },
    where: and(
      eq(oauthAccounts.userId, userId),
      eq(oauthAccounts.provider, "spotify"),
      isNull(oauthAccounts.disconnectedAt),
    ),
  });
  if (!account || !hasSpotifyPlaylistWriteScopes(account.scopes)) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify must be reauthorized with both playlist modification scopes before changing visibility.",
      "writes_disabled",
    );
  }
}

function requireAuthorizedPlaylistId(value: string): string {
  const playlistId = spotifyPlaylistIdSchema.parse(value);
  if (playlistId !== spotifyAuthorizedPlaylistId) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist visibility is restricted to the authorized playlist.",
      "playlist_id_mismatch",
    );
  }
  return playlistId;
}

function assertPlaylistIdentity(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify returned a playlist other than the configured target.",
      "playlist_id_mismatch",
    );
  }
}
