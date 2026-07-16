import { artistAliases, artists, createSpotifyImportRun } from "@radar/db";
import { createSpotifyImportPreview } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";
import { createSpotifyServerContext } from "../../../../../lib/spotify-server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 5);
    const context = await createSpotifyServerContext();
    try {
      const [followed, canonicalRows, aliasRows] = await Promise.all([
        context.client.getFollowedArtists(),
        context.db.select().from(artists),
        context.db.select().from(artistAliases),
      ]);
      const preview = createSpotifyImportPreview(
        followed,
        canonicalRows.map((artist) => ({
          aliases: aliasRows
            .filter((alias) => alias.artistId === artist.id)
            .map((alias) => alias.name),
          id: artist.id,
          manuallyEdited: true,
          name: artist.name,
        })),
      );
      const importRunId = await createSpotifyImportRun(context.db, context.userId, preview);
      const candidates = await context.db.query.artistImportCandidates.findMany({
        where: (table, { eq }) => eq(table.importRunId, importRunId),
      });
      return NextResponse.json({ candidates, importRunId, retrieved: preview.length });
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json({ error: "Unable to preview followed artists" }, { status: 400 });
  }
}
