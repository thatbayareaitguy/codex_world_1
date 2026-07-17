import {
  manualMatchDecisions,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  trackAvailabilities,
} from "@radar/db";
import {
  assertOwnedPrivateSpotifyPlaylist,
  loadProviderConfiguration,
  planSpotifyPlaylistSync,
  SpotifyPlaylistWriteDeniedError,
} from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";
import {
  assertNoPlaylistWriteRequestBody,
  configuredSpotifyPlaylistId,
  requireSpotifyPlaylistWriteRoute,
  SpotifyPlaylistRequestBodyError,
} from "../../../../lib/spotify-playlist-security";
import { createSpotifyServerContext } from "../../../../lib/spotify-server";

async function loadSyncData(
  context: Awaited<ReturnType<typeof createSpotifyServerContext>>,
  playlistId: string,
) {
  const rows = await context.db
    .select({
      candidateId: releaseCandidates.id,
      confidence: releaseCandidates.matchConfidence,
      matchRule: releaseCandidates.matchRule,
      providerTrackId: trackAvailabilities.providerTrackId,
      providerUrl: trackAvailabilities.providerUrl,
      trackId: trackAvailabilities.trackId,
    })
    .from(releaseCandidates)
    .innerJoin(
      trackAvailabilities,
      and(
        eq(releaseCandidates.matchedTrackId, trackAvailabilities.trackId),
        eq(trackAvailabilities.provider, "spotify"),
      ),
    )
    .where(eq(releaseCandidates.provider, "spotify"));
  const decisions = await context.db.select().from(manualMatchDecisions);
  const items = rows.map((row) => ({
    confidence: Number(row.confidence),
    manuallyConfirmed: decisions.some(
      (decision) => decision.candidateId === row.candidateId && decision.decision === "confirm",
    ),
    matchRule: row.matchRule,
    providerTrackId: row.providerTrackId,
    providerUrl: row.providerUrl,
  }));
  const existing = await context.client.getPlaylistTrackIds(playlistId);
  return { existing, items, rows };
}

export async function GET(): Promise<NextResponse> {
  try {
    const configuration = loadProviderConfiguration();
    const playlistId = configuredSpotifyPlaylistId(configuration);
    if (!playlistId) throw new Error("Spotify playlist is not configured");
    const context = await createSpotifyServerContext();
    try {
      const [profile, playlist] = await Promise.all([
        context.client.getCurrentUser(),
        context.client.getPlaylist(playlistId),
      ]);
      assertOwnedPrivateSpotifyPlaylist(playlist, profile);
      const data = await loadSyncData(context, playlistId);
      return NextResponse.json({
        playlistName: playlist.name,
        ...planSpotifyPlaylistSync(data.items, data.existing),
      });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to preview the configured Spotify playlist" },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    await assertNoPlaylistWriteRequestBody(request);
    const configuration = loadProviderConfiguration();
    const playlistId = requireSpotifyPlaylistWriteRoute(configuration);
    const context = await createSpotifyServerContext();
    try {
      const [profile, playlist] = await Promise.all([
        context.client.getCurrentUser(),
        context.client.getPlaylist(playlistId),
      ]);
      assertOwnedPrivateSpotifyPlaylist(playlist, profile);
      const data = await loadSyncData(context, playlistId);
      const plan = planSpotifyPlaylistSync(data.items, data.existing);
      const [target] = await context.db
        .insert(playlistTargets)
        .values({
          autoAddExactMatches: false,
          enabled: true,
          name: playlist.name,
          provider: "spotify",
          providerPlaylistId: playlistId,
          userId: context.userId,
        })
        .onConflictDoUpdate({
          target: [playlistTargets.userId, playlistTargets.provider],
          set: {
            autoAddExactMatches: false,
            enabled: true,
            name: playlist.name,
            providerPlaylistId: playlistId,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!target) throw new Error("Spotify playlist export ledger target could not be stored");
      const snapshots = await context.client.addPlaylistItems(playlistId, plan.toAdd);
      for (const providerTrackId of plan.toAdd) {
        const row = data.rows.find((candidate) => candidate.providerTrackId === providerTrackId);
        if (!row) continue;
        await context.db
          .insert(playlistExports)
          .values({
            exportedAt: new Date(),
            playlistTargetId: target.id,
            providerTrackId,
            status: "exported",
            trackId: row.trackId,
          })
          .onConflictDoUpdate({
            target: [playlistExports.playlistTargetId, playlistExports.providerTrackId],
            set: { exportedAt: new Date(), status: "exported", updatedAt: new Date() },
          });
      }
      await context.db
        .update(playlistTargets)
        .set({
          lastSyncedAt: new Date(),
          ...(snapshots.at(-1) ? { snapshotId: snapshots.at(-1) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(playlistTargets.id, target.id));
      return NextResponse.json({
        added: plan.toAdd,
        alreadyPresent: plan.alreadyPresent,
        rejected: plan.rejected,
      });
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof SpotifyPlaylistRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SpotifyPlaylistWriteDeniedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to synchronize Spotify playlist" }, { status: 400 });
  }
}
