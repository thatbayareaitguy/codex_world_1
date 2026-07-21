import { parseSpotifyReleaseArtwork, type SpotifyReleaseArtwork } from "@radar/core";
import { and, asc, eq } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { feedItems, providerCursors, releaseExternalIds, releases } from "./schema";

const cursorScope = "artwork_backfill";
const cursorScopeId = "spotify_release_artwork_v1";

export interface SpotifyArtworkBackfillRelease {
  externalId: string;
  externalRowId: string;
  providerFields: unknown;
  releaseId: string;
  title: string;
}

export interface SpotifyArtworkBackfillRepository {
  listReleases(): Promise<SpotifyArtworkBackfillRelease[]>;
  loadCursor(): Promise<string | null>;
  markUnavailable(release: SpotifyArtworkBackfillRelease, observedAt: Date): Promise<void>;
  persistArtwork(
    release: SpotifyArtworkBackfillRelease,
    artwork: SpotifyReleaseArtwork,
  ): Promise<void>;
  persistCursor(externalRowId: string): Promise<void>;
}

export function createSpotifyArtworkBackfillRepository(
  db: RadarDatabase,
): SpotifyArtworkBackfillRepository {
  return {
    async listReleases() {
      return db
        .select({
          externalId: releaseExternalIds.externalId,
          externalRowId: releaseExternalIds.id,
          providerFields: releaseExternalIds.providerFields,
          releaseId: releaseExternalIds.releaseId,
          title: releases.title,
        })
        .from(releaseExternalIds)
        .innerJoin(releases, eq(releases.id, releaseExternalIds.releaseId))
        .where(eq(releaseExternalIds.provider, "spotify"))
        .orderBy(asc(releaseExternalIds.createdAt), asc(releaseExternalIds.id));
    },
    async loadCursor() {
      const cursor = await db.query.providerCursors.findFirst({
        where: and(
          eq(providerCursors.provider, "spotify"),
          eq(providerCursors.cursorScope, cursorScope),
          eq(providerCursors.scopeId, cursorScopeId),
        ),
      });
      return cursor?.cursorValue ?? null;
    },
    async markUnavailable(release, observedAt) {
      await db
        .update(releaseExternalIds)
        .set({
          providerFields: mergeProviderFields(release.providerFields, {
            artworkBackfill: {
              observedAt: observedAt.toISOString(),
              status: "unavailable",
            },
          }),
          updatedAt: observedAt,
        })
        .where(eq(releaseExternalIds.id, release.externalRowId));
    },
    async persistArtwork(release, artwork) {
      const observedAt = new Date(artwork.lastObservedAt);
      await db.transaction(async (tx) => {
        await tx
          .update(releaseExternalIds)
          .set({
            providerFields: mergeProviderFields(release.providerFields, {
              artworkBackfill: {
                observedAt: artwork.lastObservedAt,
                status: "updated",
              },
              spotify: artwork,
            }),
            updatedAt: observedAt,
          })
          .where(eq(releaseExternalIds.id, release.externalRowId));
        await tx
          .update(feedItems)
          .set({ updatedAt: observedAt })
          .where(eq(feedItems.releaseId, release.releaseId));
      });
    },
    async persistCursor(externalRowId) {
      const now = new Date();
      await db
        .insert(providerCursors)
        .values({
          cursorScope,
          cursorValue: externalRowId,
          provider: "spotify",
          scopeId: cursorScopeId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: { cursorValue: externalRowId, updatedAt: now },
          target: [providerCursors.provider, providerCursors.cursorScope, providerCursors.scopeId],
        });
    },
  };
}

export function hasValidSpotifyArtwork(providerFields: unknown): boolean {
  return parseSpotifyReleaseArtwork(recordValue(providerFields, "spotify")) !== null;
}

export function artworkBackfillCompleted(providerFields: unknown): boolean {
  if (hasValidSpotifyArtwork(providerFields)) return true;
  const state = recordValue(providerFields, "artworkBackfill");
  return isRecord(state) && state.status === "unavailable";
}

function mergeProviderFields(
  value: unknown,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(isRecord(value) ? value : {}), ...additions };
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
