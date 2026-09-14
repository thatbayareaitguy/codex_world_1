import { and, eq } from "drizzle-orm";
import { spotifyPlaylistMutationEvidenceSchema as proofSchema } from "@radar/providers";
import type { RadarDatabase } from "./client";
import { providerCache } from "./schema";

export type PlaylistEvidenceDatabase = Pick<
  RadarDatabase,
  "query" | "insert" | "update" | "delete"
>;
export type SpotifyPlaylistMutationEvidence = ReturnType<typeof proofSchema.parse>;
const proofKey = (targetId: string) => `playlist-mutation-evidence:${targetId}`;

export async function loadSpotifyPlaylistMutationEvidence(
  db: PlaylistEvidenceDatabase,
  targetId: string,
) {
  const row = await db.query.providerCache.findFirst({
    where: and(
      eq(providerCache.provider, "spotify"),
      eq(providerCache.cacheKey, proofKey(targetId)),
    ),
  });
  const parsed = proofSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function saveSpotifyPlaylistMutationEvidence(
  db: PlaylistEvidenceDatabase,
  targetId: string,
  evidence: SpotifyPlaylistMutationEvidence,
) {
  const value = proofSchema.parse(evidence);
  const now = new Date();
  await db
    .insert(providerCache)
    .values({
      provider: "spotify",
      cacheKey: proofKey(targetId),
      value,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    })
    .onConflictDoUpdate({
      target: [providerCache.provider, providerCache.cacheKey],
      set: { value, updatedAt: now, expiresAt: new Date(now.getTime() + 30 * 86_400_000) },
    });
}

export async function clearSpotifyPlaylistMutationEvidence(
  db: PlaylistEvidenceDatabase,
  targetId: string,
) {
  await db
    .delete(providerCache)
    .where(
      and(eq(providerCache.provider, "spotify"), eq(providerCache.cacheKey, proofKey(targetId))),
    );
}

export async function recordSpotifyPlaylistMutationEvidence(
  db: PlaylistEvidenceDatabase,
  targetId: string,
  before: string,
  after: string,
  fullReadAt: Date | null,
) {
  const previous = await loadSpotifyPlaylistMutationEvidence(db, targetId);
  await saveSpotifyPlaylistMutationEvidence(db, targetId, {
    version: 1,
    snapshotId: after,
    acknowledgedAt: new Date().toISOString(),
    fullReadAt:
      previous?.snapshotId === before ? previous.fullReadAt : (fullReadAt?.toISOString() ?? null),
    previousSnapshotIds: [
      ...new Set([
        ...(previous?.snapshotId === before ? previous.previousSnapshotIds : []),
        before,
      ]),
    ].slice(-64),
    checkNotBefore: null,
    lagChecks: 0,
  });
}

export class SpotifyPlaylistMetadataLagError extends Error {
  constructor(readonly checkNotBefore: Date) {
    super("Playlist metadata has not caught up with acknowledged writes; verification deferred.");
    this.name = "SpotifyPlaylistMetadataLagError";
  }
}
