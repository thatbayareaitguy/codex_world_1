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
      spotifyCoverage: artist.spotifyCoverage
        ? {
            catalogPagesCompleted: artist.spotifyCoverage.catalogPagesCompleted,
            dailyScanCompletedAt:
              artist.spotifyCoverage.dailyScanCompletedAt?.toISOString() ?? null,
            lastFullReconciliationAt:
              artist.spotifyCoverage.lastFullReconciliationAt?.toISOString() ?? null,
            nextOffset: artist.spotifyCoverage.nextOffset,
            pagesScannedInCycle: artist.spotifyCoverage.pagesScannedInCycle,
            partial: artist.spotifyCoverage.partial,
            status: artist.spotifyCoverage.status,
          }
        : null,
    }));
  } finally {
    await connection.client.end();
  }
}
