import {
  createDatabase,
  ensureLocalOwner,
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  latestSpotifyBatch,
  oauthAccounts,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const config = loadProviderConfiguration();
  if (!config.spotify.enabled) return NextResponse.json({ state: "disabled" });
  if (!config.spotify.configured || !config.databaseUrl) {
    return NextResponse.json({ state: "missing_configuration" });
  }
  const connection = createDatabase(config.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const [account, operational, batch, scheduler] = await Promise.all([
      connection.db.query.oauthAccounts.findFirst({
        where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "spotify")),
        columns: {
          disconnectedAt: true,
          displayName: true,
          lastTokenRefreshAt: true,
          reconnectRequired: true,
          scopes: true,
        },
      }),
      getSpotifyOperationalStatus(connection.db),
      latestSpotifyBatch(connection.db),
      getSpotifySchedulerStatus(connection.db),
    ]);
    if (!account || account.disconnectedAt) {
      return NextResponse.json({ batch, operational, scheduler, state: "disconnected" });
    }
    return NextResponse.json({
      batch,
      displayName: account.displayName,
      lastTokenRefreshAt: account.lastTokenRefreshAt,
      operational,
      scheduler,
      scopes: account.scopes,
      state: account.reconnectRequired ? "reconnect_required" : "connected",
    });
  } finally {
    await connection.client.end();
  }
}
