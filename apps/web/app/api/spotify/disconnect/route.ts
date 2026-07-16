import { createDatabase, disconnectSpotifyAccount, ensureLocalOwner } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request);
    const config = loadProviderConfiguration();
    if (!config.databaseUrl)
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    const connection = createDatabase(config.databaseUrl);
    try {
      const userId = await ensureLocalOwner(connection.db);
      await disconnectSpotifyAccount(connection.db, userId);
      return NextResponse.json({ disconnected: true, canonicalWatchlistPreserved: true });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Spotify disconnect failed" }, { status: 400 });
  }
}
