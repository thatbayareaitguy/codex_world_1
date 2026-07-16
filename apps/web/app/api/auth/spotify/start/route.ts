import { createDatabase, ensureLocalOwner, persistOAuthState } from "@radar/db";
import {
  createOAuthChallenge,
  encryptSecret,
  loadProviderConfiguration,
  signFlowCookie,
  SpotifyOAuthClient,
} from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "../../../../../lib/request-security";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    enforceRateLimit(request, 10);
    const config = loadProviderConfiguration();
    if (
      !config.spotify.enabled ||
      !config.spotify.configured ||
      !config.spotify.clientId ||
      !config.spotify.clientSecret ||
      !config.appEncryptionKey ||
      !config.databaseUrl
    ) {
      return NextResponse.json({ error: "Spotify is not configured" }, { status: 503 });
    }
    const connection = createDatabase(config.databaseUrl);
    try {
      const userId = await ensureLocalOwner(connection.db);
      const challenge = createOAuthChallenge();
      const verifier = encryptSecret(challenge.codeVerifier, config.appEncryptionKey);
      const flowId = await persistOAuthState(connection.db, {
        encryptedVerifier: verifier,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        stateHash: challenge.stateHash,
        userId,
      });
      const oauth = new SpotifyOAuthClient({
        clientId: config.spotify.clientId,
        clientSecret: config.spotify.clientSecret,
        redirectUri: config.spotify.redirectUri,
      });
      const response = NextResponse.redirect(
        oauth.authorizationUrl(challenge.state, challenge.codeChallenge),
      );
      response.cookies.set("spotify_oauth_flow", signFlowCookie(flowId, config.appEncryptionKey), {
        httpOnly: true,
        maxAge: 600,
        path: "/api/auth/spotify/callback",
        sameSite: "lax",
        secure: config.appBaseUrl.startsWith("https://"),
      });
      return response;
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Unable to start Spotify authorization" }, { status: 500 });
  }
}
