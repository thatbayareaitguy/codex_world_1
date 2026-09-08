import type {
  SpotifyPlaylist,
  SpotifyPlaylistItemSnapshot,
  SpotifyPlaylistItemsPage,
  SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { assertSpotifyPlaylistWriteTarget } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { playlistTargets, providerCache } from "./schema";

export interface SpotifyPlaylistSnapshotClient {
  getPlaylist: (id: string, signal?: AbortSignal) => Promise<SpotifyPlaylist>;
  getPlaylistItems: (id: string, signal?: AbortSignal) => Promise<SpotifyPlaylistItemSnapshot[]>;
  getPlaylistItemsPage?: (
    id: string,
    offset: number,
    signal?: AbortSignal,
  ) => Promise<SpotifyPlaylistItemsPage>;
}

export interface VerifiedSpotifyPlaylistSnapshot {
  cacheHit: boolean;
  items: SpotifyPlaylistItemSnapshot[];
  playlist: SpotifyPlaylist;
  targetId: string;
}

export class SpotifyPlaylistSnapshotYieldError extends Error {
  constructor(readonly nextOffset: number) {
    super(`Spotify playlist snapshot refresh yielded at offset ${nextOffset}.`);
    this.name = "SpotifyPlaylistSnapshotYieldError";
  }
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
  options: {
    forceRefresh?: boolean;
    maxReadPages?: number;
    policy?: SpotifyPlaylistWritePolicy;
  } = {},
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
    await clearPlaylistSnapshotRefresh(db, userId, playlistId);
    const verifiedAt = new Date();
    await db
      .update(playlistTargets)
      .set({ snapshotVerifiedAt: verifiedAt, updatedAt: verifiedAt })
      .where(eq(playlistTargets.id, target.id));
    return {
      cacheHit: true,
      items: target.snapshotItems,
      playlist,
      targetId: target.id,
    };
  }
  const pageReader = client.getPlaylistItemsPage;
  const refreshed =
    options.maxReadPages !== undefined && pageReader
      ? await readBoundedConsistentSpotifyPlaylistSnapshot(db, userId, client, playlist, {
          getPage: pageReader,
          maxReadPages: options.maxReadPages,
        })
      : await readConsistentSpotifyPlaylistSnapshot(client, playlist);
  await persistSpotifyPlaylistSnapshot(
    db,
    target.id,
    refreshed.playlist.snapshot_id,
    refreshed.items,
  );
  return { cacheHit: false, ...refreshed, targetId: target.id };
}

interface PlaylistSnapshotRefreshState {
  items: SpotifyPlaylistItemSnapshot[];
  nextOffset: number | null;
  playlistId: string;
  snapshotId: string;
  startedAt: string;
}

async function readBoundedConsistentSpotifyPlaylistSnapshot(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistSnapshotClient,
  initialPlaylist: SpotifyPlaylist,
  options: {
    getPage: NonNullable<SpotifyPlaylistSnapshotClient["getPlaylistItemsPage"]>;
    maxReadPages: number;
  },
): Promise<{ items: SpotifyPlaylistItemSnapshot[]; playlist: SpotifyPlaylist }> {
  if (!Number.isInteger(options.maxReadPages) || options.maxReadPages < 1) {
    throw new Error("Spotify playlist snapshot maximum read pages must be a positive integer.");
  }
  let state = await loadPlaylistSnapshotRefresh(db, userId, initialPlaylist.id);
  if (state?.snapshotId !== initialPlaylist.snapshot_id) {
    await clearPlaylistSnapshotRefresh(db, userId, initialPlaylist.id);
    state = null;
  }
  state ??= {
    items: [],
    nextOffset: 0,
    playlistId: initialPlaylist.id,
    snapshotId: initialPlaylist.snapshot_id,
    startedAt: new Date().toISOString(),
  };

  let pagesRead = 0;
  while (state.nextOffset !== null && pagesRead < options.maxReadPages) {
    const page = await options.getPage(initialPlaylist.id, state.nextOffset);
    state = {
      ...state,
      items: [...state.items, ...page.items],
      nextOffset: page.nextOffset,
    };
    await persistPlaylistSnapshotRefresh(db, userId, state);
    pagesRead += 1;
  }
  if (state.nextOffset !== null) {
    throw new SpotifyPlaylistSnapshotYieldError(state.nextOffset);
  }

  const verified = await client.getPlaylist(initialPlaylist.id);
  if (verified.snapshot_id !== state.snapshotId) {
    await clearPlaylistSnapshotRefresh(db, userId, initialPlaylist.id);
    throw new SpotifyPlaylistSnapshotYieldError(0);
  }
  await clearPlaylistSnapshotRefresh(db, userId, initialPlaylist.id);
  return { items: state.items, playlist: verified };
}

async function loadPlaylistSnapshotRefresh(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
): Promise<PlaylistSnapshotRefreshState | null> {
  const row = await db.query.providerCache.findFirst({
    where: and(
      eq(providerCache.provider, "spotify"),
      eq(providerCache.cacheKey, playlistSnapshotRefreshKey(userId, playlistId)),
    ),
  });
  return parsePlaylistSnapshotRefreshState(row?.value, playlistId);
}

async function persistPlaylistSnapshotRefresh(
  db: RadarDatabase,
  userId: string,
  state: PlaylistSnapshotRefreshState,
): Promise<void> {
  const now = new Date();
  await db
    .insert(providerCache)
    .values({
      cacheKey: playlistSnapshotRefreshKey(userId, state.playlistId),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      provider: "spotify",
      value: state,
    })
    .onConflictDoUpdate({
      target: [providerCache.provider, providerCache.cacheKey],
      set: {
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        updatedAt: now,
        value: state,
      },
    });
}

async function clearPlaylistSnapshotRefresh(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
): Promise<void> {
  await db
    .delete(providerCache)
    .where(
      and(
        eq(providerCache.provider, "spotify"),
        eq(providerCache.cacheKey, playlistSnapshotRefreshKey(userId, playlistId)),
      ),
    );
}

function playlistSnapshotRefreshKey(userId: string, playlistId: string): string {
  return `playlist-snapshot-refresh:${userId}:${playlistId}`;
}

function parsePlaylistSnapshotRefreshState(
  value: unknown,
  playlistId: string,
): PlaylistSnapshotRefreshState | null {
  if (!isRecord(value) || value.playlistId !== playlistId) return null;
  if (typeof value.snapshotId !== "string" || typeof value.startedAt !== "string") return null;
  if (!(
    value.nextOffset === null ||
    (Number.isInteger(value.nextOffset) && Number(value.nextOffset) >= 0)
  )) {
    return null;
  }
  if (!Array.isArray(value.items) || !value.items.every(isPlaylistSnapshotItem)) return null;
  return value as unknown as PlaylistSnapshotRefreshState;
}

function isPlaylistSnapshotItem(value: unknown): value is SpotifyPlaylistItemSnapshot {
  return (
    isRecord(value) &&
    Number.isInteger(value.position) &&
    (value.trackId === null || typeof value.trackId === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
