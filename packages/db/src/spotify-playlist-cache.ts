import type {
  SpotifyPlaylist,
  SpotifyPlaylistItemSnapshot,
  SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { assertSpotifyPlaylistWriteTarget } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { playlistTargets } from "./schema";

export interface SpotifyPlaylistSnapshotClient {
  getPlaylist: (id: string, signal?: AbortSignal) => Promise<SpotifyPlaylist>;
  getPlaylistItems: (id: string, signal?: AbortSignal) => Promise<SpotifyPlaylistItemSnapshot[]>;
}

export interface VerifiedSpotifyPlaylistSnapshot {
  cacheHit: boolean;
  items: SpotifyPlaylistItemSnapshot[];
  playlist: SpotifyPlaylist;
  targetId: string;
}

export async function upsertSpotifyPlaylistTarget(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  name: string,
) {
  const [target] = await db
    .insert(playlistTargets)
    .values({
      autoAddExactMatches: false,
      enabled: true,
      name,
      provider: "spotify",
      providerPlaylistId: playlistId,
      userId,
    })
    .onConflictDoUpdate({
      target: [playlistTargets.userId, playlistTargets.provider],
      set: {
        autoAddExactMatches: false,
        enabled: true,
        name,
        providerPlaylistId: playlistId,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!target) throw new Error("Spotify playlist target could not be persisted.");
  return target;
}

export async function loadVerifiedSpotifyPlaylistSnapshot(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistSnapshotClient,
  playlist: SpotifyPlaylist,
  options: { forceRefresh?: boolean; policy?: SpotifyPlaylistWritePolicy } = {},
): Promise<VerifiedSpotifyPlaylistSnapshot> {
  const playlistId = options.policy
    ? assertSpotifyPlaylistWriteTarget(options.policy, playlist.id)
    : playlist.id;
  const target = await upsertSpotifyPlaylistTarget(db, userId, playlistId, playlist.name);
  if (
    !options.forceRefresh &&
    target.snapshotId === playlist.snapshot_id &&
    Array.isArray(target.snapshotItems)
  ) {
    return {
      cacheHit: true,
      items: target.snapshotItems,
      playlist,
      targetId: target.id,
    };
  }
  const refreshed = await readConsistentSpotifyPlaylistSnapshot(client, playlist);
  await persistSpotifyPlaylistSnapshot(
    db,
    target.id,
    refreshed.playlist.snapshot_id,
    refreshed.items,
  );
  return { cacheHit: false, ...refreshed, targetId: target.id };
}

export async function persistSpotifyPlaylistSnapshot(
  db: RadarDatabase,
  targetId: string,
  snapshotId: string,
  items: readonly SpotifyPlaylistItemSnapshot[],
  options: { canaryVerified?: boolean } = {},
): Promise<void> {
  const now = new Date();
  await db
    .update(playlistTargets)
    .set({
      lastSyncedAt: now,
      ...(options.canaryVerified ? { orderCanaryVerifiedAt: now } : {}),
      snapshotId,
      snapshotItems: items.map((item, position) => ({ ...item, position })),
      snapshotVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(playlistTargets.id, targetId));
}

export async function invalidateSpotifyPlaylistSnapshot(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
): Promise<void> {
  await db
    .update(playlistTargets)
    .set({ snapshotId: null, snapshotItems: null, snapshotVerifiedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(playlistTargets.userId, userId),
        eq(playlistTargets.provider, "spotify"),
        eq(playlistTargets.providerPlaylistId, playlistId),
      ),
    );
}

async function readConsistentSpotifyPlaylistSnapshot(
  client: SpotifyPlaylistSnapshotClient,
  initialPlaylist: SpotifyPlaylist,
): Promise<{ items: SpotifyPlaylistItemSnapshot[]; playlist: SpotifyPlaylist }> {
  let playlist = initialPlaylist;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const items = await client.getPlaylistItems(playlist.id);
    const verified = await client.getPlaylist(playlist.id);
    if (verified.snapshot_id === playlist.snapshot_id) return { items, playlist: verified };
    playlist = verified;
  }
  throw new Error("Spotify playlist changed while its ordered snapshot was being read.");
}
