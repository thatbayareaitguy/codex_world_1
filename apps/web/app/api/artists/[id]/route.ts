import { createDatabase, deactivateFollowedArtist, ensureLocalOwner } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const artistIdSchema = z.uuid();

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 60, 60_000, "/api/artists");
    const artistId = artistIdSchema.parse((await context.params).id);
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }

    const connection = createDatabase(configuration.databaseUrl);
    try {
      const userId = await ensureLocalOwner(connection.db);
      const result = await deactivateFollowedArtist(connection.db, userId, artistId);
      if (!result) {
        return NextResponse.json({ error: "Followed artist not found" }, { status: 404 });
      }
      return NextResponse.json({ removed: true, result });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Unable to remove followed artist" }, { status: 400 });
  }
}
