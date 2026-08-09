import {
  applySpotifyPlaylistReorderMove,
  assertOwnedPrivateSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  hasSpotifyPlaylistWriteScopes,
  planSpotifyPlaylistReleaseDateOrder,
  spotifyPlaylistIdSchema,
  SpotifyPlaylistWriteDeniedError,
  type SpotifyClient,
  type SpotifyPlaylistItemSnapshot,
  type SpotifyPlaylistReleaseDateOrderPlan,
  type SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { and, eq, isNull } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  loadVerifiedSpotifyPlaylistSnapshot,
  persistSpotifyPlaylistSnapshot,
} from "./spotify-playlist-cache";
import { oauthAccounts, playlistTargets } from "./schema";

export interface SpotifyPlaylistOrderClient {
  getCurrentUser: SpotifyClient["getCurrentUser"];
  getPlaylist: SpotifyClient["getPlaylist"];
  getPlaylistItems: SpotifyClient["getPlaylistItems"];
  reorderPlaylistItems: SpotifyClient["reorderPlaylistItems"];
}

export interface SpotifyPlaylistOrderPreview {
  cacheHit: boolean;
  plan: SpotifyPlaylistReleaseDateOrderPlan;
  target: {
    id: string;
    itemCount: number;
    name: string;
    snapshotId: string;
  };
}

export interface SpotifyPlaylistOrderExecution extends SpotifyPlaylistOrderPreview {
  result: {
    addedAtPreserved: boolean;
    afterCount: number;
    beforeCount: number;
    canary: boolean;
    itemMultisetPreserved: boolean;
    operationsPerformed: number;
    remainingMoves: number;
    snapshotAfter: string;
  };
}

export async function previewSpotifyPlaylistCustomOrder(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistOrderClient,
  configuredPlaylistId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<SpotifyPlaylistOrderPreview> {
  const playlistId = spotifyPlaylistIdSchema.parse(configuredPlaylistId);
  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedPrivateSpotifyPlaylist(playlist, profile);
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist, {
    forceRefresh: options.forceRefresh ?? false,
  });
  return {
    cacheHit: snapshot.cacheHit,
    plan: planSpotifyPlaylistReleaseDateOrder(snapshot.items),
    target: {
      id: playlistId,
      itemCount: snapshot.items.length,
      name: playlist.name,
      snapshotId: snapshot.playlist.snapshot_id,
    },
  };
}

export async function executeSpotifyPlaylistCustomOrder(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistOrderClient,
  input: {
    canary: boolean;
    forceRefresh?: boolean;
    playlistId: string;
    policy: SpotifyPlaylistWritePolicy;
  },
): Promise<SpotifyPlaylistOrderExecution> {
  const playlistId = assertSpotifyPlaylistWriteTarget(input.policy, input.playlistId);
  await requireSpotifyPlaylistWriteScope(db, userId);
  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedPrivateSpotifyPlaylist(playlist, profile);
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist, {
    forceRefresh: input.forceRefresh ?? false,
    policy: input.policy,
  });
  const plan = planSpotifyPlaylistReleaseDateOrder(snapshot.items);
  const moves = input.canary ? plan.moves.slice(0, 1) : plan.moves;
  let working = snapshot.items;
  let snapshotId = snapshot.playlist.snapshot_id;
  for (const move of moves) {
    snapshotId = await client.reorderPlaylistItems(playlistId, { ...move, snapshotId });
    working = applySpotifyPlaylistReorderMove(working, move);
    await persistSpotifyPlaylistSnapshot(db, snapshot.targetId, snapshotId, working);
  }

  const finalPlaylist = { ...snapshot.playlist, snapshot_id: snapshotId };
  const verified = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, finalPlaylist, {
    ...(moves.length > 0 || input.forceRefresh ? { forceRefresh: true } : {}),
    policy: input.policy,
  });
  const itemMultisetPreserved = sameMultiset(
    snapshot.items.map((item) => item.trackId),
    verified.items.map((item) => item.trackId),
  );
  const addedAtPreserved = sameMultiset(
    snapshot.items.map(addedAtIdentity),
    verified.items.map(addedAtIdentity),
  );
  if (
    !itemMultisetPreserved ||
    !addedAtPreserved ||
    verified.items.length !== snapshot.items.length
  ) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist reorder changed playlist membership or Date Added metadata",
      "playlist_reorder_invalid",
    );
  }
  const remaining = planSpotifyPlaylistReleaseDateOrder(verified.items);
  if (!input.canary && remaining.moves.length > 0) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify playlist reorder verification did not reach the requested Custom Order.",
      "playlist_reorder_invalid",
    );
  }
  if (input.canary && moves.length > 0) {
    await persistSpotifyPlaylistSnapshot(
      db,
      snapshot.targetId,
      verified.playlist.snapshot_id,
      verified.items,
      { canaryVerified: true },
    );
  }
  return {
    cacheHit: snapshot.cacheHit,
    plan,
    result: {
      addedAtPreserved,
      afterCount: verified.items.length,
      beforeCount: snapshot.items.length,
      canary: input.canary,
      itemMultisetPreserved,
      operationsPerformed: moves.length,
      remainingMoves: remaining.moves.length,
      snapshotAfter: verified.playlist.snapshot_id,
    },
    target: {
      id: playlistId,
      itemCount: verified.items.length,
      name: playlist.name,
      snapshotId: snapshot.playlist.snapshot_id,
    },
  };
}

export async function hasVerifiedSpotifyPlaylistOrderCanary(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
): Promise<boolean> {
  const target = await db.query.playlistTargets.findFirst({
    columns: { orderCanaryVerifiedAt: true },
    where: and(
      eq(playlistTargets.userId, userId),
      eq(playlistTargets.provider, "spotify"),
      eq(playlistTargets.providerPlaylistId, playlistId),
    ),
  });
  return Boolean(target?.orderCanaryVerifiedAt);
}

function addedAtIdentity(item: SpotifyPlaylistItemSnapshot): string {
  return `${item.trackId ?? "<unknown>"}|${item.addedAt ?? ""}|${item.addedById ?? ""}`;
}

function sameMultiset<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<T, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of right) {
    const count = counts.get(item) ?? 0;
    if (count < 1) return false;
    if (count === 1) counts.delete(item);
    else counts.set(item, count - 1);
  }
  return counts.size === 0;
}

async function requireSpotifyPlaylistWriteScope(db: RadarDatabase, userId: string): Promise<void> {
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
      "Spotify must be reauthorized with both playlist modification scopes before reordering.",
      "writes_disabled",
    );
  }
}

function assertPlaylistIdentity(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify returned a playlist other than the configured target",
      "playlist_id_mismatch",
    );
  }
}
