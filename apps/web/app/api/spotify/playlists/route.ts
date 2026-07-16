import { playlistTargets } from "@radar/db";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";
import { createSpotifyServerContext } from "../../../../lib/spotify-server";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), name: z.string().trim().min(1).max(100) }),
  z.object({ mode: z.literal("select"), playlistId: z.string().min(1) }),
  z.object({ enabled: z.boolean(), mode: z.literal("auto_add") }),
]);

export async function GET(): Promise<NextResponse> {
  try {
    const context = await createSpotifyServerContext();
    try {
      const [profile, playlists] = await Promise.all([
        context.client.getCurrentUser(),
        context.client.getMyPlaylists(),
      ]);
      const ownedPrivate = playlists.filter(
        (playlist) =>
          playlist.public === false &&
          (playlist.owner?.account_id === profile.account_id || playlist.owner?.id === profile.id),
      );
      const target = await context.db.query.playlistTargets.findFirst({
        where: and(
          eq(playlistTargets.userId, context.userId),
          eq(playlistTargets.provider, "spotify"),
        ),
      });
      return NextResponse.json({ playlists: ownedPrivate, target });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to load Spotify playlists" }, { status: 400 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    const body = bodySchema.parse(await request.json());
    const context = await createSpotifyServerContext();
    try {
      if (body.mode === "auto_add") {
        const [target] = await context.db
          .update(playlistTargets)
          .set({ autoAddExactMatches: body.enabled, updatedAt: new Date() })
          .where(
            and(
              eq(playlistTargets.userId, context.userId),
              eq(playlistTargets.provider, "spotify"),
            ),
          )
          .returning();
        if (!target) {
          return NextResponse.json(
            { error: "Configure a Spotify playlist before enabling auto-add" },
            { status: 400 },
          );
        }
        return NextResponse.json({ target });
      }
      const existingTarget = await context.db.query.playlistTargets.findFirst({
        where: and(
          eq(playlistTargets.userId, context.userId),
          eq(playlistTargets.provider, "spotify"),
        ),
      });
      const playlist =
        body.mode === "create"
          ? existingTarget?.providerPlaylistId
            ? await context.client.getPlaylist(existingTarget.providerPlaylistId)
            : await context.client.createPrivatePlaylist(body.name)
          : await context.client.getPlaylist(body.playlistId);
      if (playlist.public !== false) {
        return NextResponse.json(
          { error: "Only a private Spotify playlist can be selected" },
          { status: 400 },
        );
      }
      if (body.mode === "select") {
        const profile = await context.client.getCurrentUser();
        if (
          playlist.owner?.account_id !== profile.account_id &&
          playlist.owner?.id !== profile.id
        ) {
          return NextResponse.json(
            { error: "Only an owned private Spotify playlist can be selected" },
            { status: 400 },
          );
        }
      }
      const [target] = await context.db
        .insert(playlistTargets)
        .values({
          name: playlist.name,
          provider: "spotify",
          providerPlaylistId: playlist.id,
          snapshotId: playlist.snapshot_id,
          userId: context.userId,
        })
        .onConflictDoUpdate({
          target: [playlistTargets.userId, playlistTargets.provider],
          set: {
            enabled: true,
            name: playlist.name,
            providerPlaylistId: playlist.id,
            snapshotId: playlist.snapshot_id,
            updatedAt: new Date(),
          },
        })
        .returning();
      return NextResponse.json({ playlist, target });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to configure Spotify playlist" }, { status: 400 });
  }
}
