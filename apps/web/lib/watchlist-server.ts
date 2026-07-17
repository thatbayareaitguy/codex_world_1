import { createDatabase, ensureLocalOwner, listFollowedArtists } from "@radar/db";
import type { WatchlistArtistViewModel } from "./watchlist-types";

export async function loadDatabaseWatchlist(
  databaseUrl: string,
): Promise<WatchlistArtistViewModel[]> {
  const connection = createDatabase(databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const followed = await listFollowedArtists(connection.db, userId);
    return followed.map((artist) => ({
      active: artist.active,
      addedAt: artist.followedAt.toISOString(),
      id: artist.artistId,
      name: artist.name,
      providers: artist.providers,
      source: artist.source,
    }));
  } finally {
    await connection.client.end();
  }
}
