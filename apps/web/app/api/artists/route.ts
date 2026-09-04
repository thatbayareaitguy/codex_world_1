import { loadProviderConfiguration } from "@radar/providers";
import { NextResponse } from "next/server";
import { loadDatabaseWatchlist } from "../../../lib/watchlist-server";

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const artists = await loadDatabaseWatchlist(configuration.databaseUrl);
    return NextResponse.json(
      {
        activeCount: artists.filter((artist) => artist.active).length,
        artists,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Unable to load followed artists" }, { status: 500 });
  }
}
