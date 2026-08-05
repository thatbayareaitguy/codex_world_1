import {
  executeSpotifyPlaylistExport,
  previewSpotifyPlaylistExport,
  SpotifyPlaylistExportError,
  type SpotifyPlaylistExportPreview,
} from "@radar/db";
import { loadProviderConfiguration, SpotifyPlaylistWriteDeniedError } from "@radar/providers";
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

export async function GET(): Promise<NextResponse> {
  try {
    const configuration = loadProviderConfiguration();
    const playlistId = configuredSpotifyPlaylistId(configuration);
    if (!playlistId) throw new Error("Spotify playlist is not configured");
    const context = await createSpotifyServerContext();
    try {
      const preview = await previewSpotifyPlaylistExport(
        context.db,
        context.userId,
        context.client,
        playlistId,
      );
      return NextResponse.json(toResponse(preview));
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
      const result = await executeSpotifyPlaylistExport(
        context.db,
        context.userId,
        context.client,
        {
          playlistId,
          policy: {
            allowedPlaylistId: playlistId,
            enabled: configuration.spotify.playlistWritesEnabled,
          },
        },
      );
      return NextResponse.json({ ...toResponse(result), run: result.run });
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof SpotifyPlaylistRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof SpotifyPlaylistWriteDeniedError ||
      error instanceof SpotifyPlaylistExportError
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to synchronize Spotify playlist" }, { status: 400 });
  }
}

function toResponse(preview: SpotifyPlaylistExportPreview) {
  const skipCounts = Object.fromEntries(
    [...new Set(preview.plan.skips.map((item) => item.reason))]
      .sort()
      .map((reason) => [
        reason,
        preview.plan.skips.filter((item) => item.reason === reason).length,
      ]),
  );
  return {
    additions: preview.plan.additions.map((item) => ({
      artistOrder: item.desiredOrdinal,
      position: item.position,
      providerTrackId: item.providerTrackId,
      releaseDate: item.releaseDate,
      releaseTitle: item.releaseTitle,
      title: item.title,
    })),
    alreadyPresent: preview.plan.alreadyPresent.map((item) => ({
      appManaged: item.appManaged,
      position: item.position,
      providerTrackId: item.providerTrackId,
      title: item.title,
    })),
    existingDuplicateTrackIds: preview.plan.existingDuplicateTrackIds,
    orderingConflicts: preview.plan.orderingConflicts,
    skipCounts,
    skipped: preview.plan.skips,
    target: preview.target,
    totals: {
      additions: preview.plan.additions.length,
      alreadyPresent: preview.plan.alreadyPresent.length,
      eligible: preview.plan.desired.length,
      finalPlaylistItems: preview.plan.finalTrackIds.length,
      orderingConflicts: preview.plan.orderingConflicts.length,
      skipped: preview.plan.skips.length,
    },
  };
}
