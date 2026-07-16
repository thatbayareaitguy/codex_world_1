import { createDatabase, ensureLocalOwner, oauthAccounts } from "@radar/db";
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
    const account = await connection.db.query.oauthAccounts.findFirst({
      where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "spotify")),
      columns: {
        disconnectedAt: true,
        displayName: true,
        lastTokenRefreshAt: true,
        reconnectRequired: true,
        scopes: true,
      },
    });
    if (!account || account.disconnectedAt) return NextResponse.json({ state: "disconnected" });
    return NextResponse.json({
      displayName: account.displayName,
      lastTokenRefreshAt: account.lastTokenRefreshAt,
      scopes: account.scopes,
      state: account.reconnectRequired ? "reconnect_required" : "connected",
    });
  } finally {
    await connection.client.end();
  }
}
