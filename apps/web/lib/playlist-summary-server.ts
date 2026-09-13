import { createDatabase, ensureLocalOwner, inspectSpotifyPlaylistCheckpoint } from "@radar/db";

export interface SpotifyPlaylistDashboardSummary {
  blocked: number;
  exported: number;
  pendingReorderMoves: number;
  ready: number;
}

export async function loadDatabaseSpotifyPlaylistSummary(
  databaseUrl: string,
  playlistId: string,
): Promise<SpotifyPlaylistDashboardSummary> {
  const connection = createDatabase(databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const inspection = await inspectSpotifyPlaylistCheckpoint(connection.db, userId, playlistId);
    return {
      blocked: inspection.blockedCount,
      exported: inspection.exportedCount,
      pendingReorderMoves: inspection.reorderMoveCount,
      ready: inspection.pendingAdditionCount,
    };
  } finally {
    await connection.client.end();
  }
}
