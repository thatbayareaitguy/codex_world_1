import {
  manualMatchDecisions,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  trackAvailabilities,
} from "@radar/db";
import { planSpotifyPlaylistSync } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";
import { createSpotifyServerContext } from "../../../../lib/spotify-server";

async function loadSyncData(context: Awaited<ReturnType<typeof createSpotifyServerContext>>) {
  const target = await context.db.query.playlistTargets.findFirst({
    where: and(eq(playlistTargets.userId, context.userId), eq(playlistTargets.provider, "spotify")),
  });
  if (!target?.providerPlaylistId) throw new Error("Spotify playlist is not configured");
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
  const existing = await context.client.getPlaylistTrackIds(target.providerPlaylistId);
  return { existing, items, rows, target };
}

export async function GET(): Promise<NextResponse> {
  try {
    const context = await createSpotifyServerContext();
    try {
      const data = await loadSyncData(context);
      return NextResponse.json({
        playlistName: data.target.name,
        ...planSpotifyPlaylistSync(data.items, data.existing),
      });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to preview playlist synchronization" },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    const context = await createSpotifyServerContext();
    try {
      const data = await loadSyncData(context);
      const plan = planSpotifyPlaylistSync(data.items, data.existing);
      const snapshots = await context.client.addPlaylistItems(
        data.target.providerPlaylistId!,
        plan.toAdd,
      );
      for (const providerTrackId of plan.toAdd) {
        const row = data.rows.find((candidate) => candidate.providerTrackId === providerTrackId);
        if (!row) continue;
        await context.db
          .insert(playlistExports)
          .values({
            exportedAt: new Date(),
            playlistTargetId: data.target.id,
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
        .where(eq(playlistTargets.id, data.target.id));
      return NextResponse.json({
        added: plan.toAdd,
        alreadyPresent: plan.alreadyPresent,
        rejected: plan.rejected,
      });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to synchronize Spotify playlist" }, { status: 400 });
  }
}
