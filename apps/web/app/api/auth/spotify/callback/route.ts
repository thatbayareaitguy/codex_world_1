import {
  consumeOAuthState,
  createDatabase,
  ensureLocalOwner,
  upsertSpotifyAccount,
} from "@radar/db";
import {
  decryptSecret,
  encryptSecret,
  hashOAuthState,
  loadProviderConfiguration,
  SpotifyClient,
  SpotifyOAuthClient,
  verifyFlowCookie,
} from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "../../../../../lib/request-security";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = loadProviderConfiguration();
  const destination = new URL("/?spotify=error#settings", config.appBaseUrl);
  try {
    enforceRateLimit(request, 20);
    if (
      !config.spotify.configured ||
      !config.spotify.clientId ||
      !config.spotify.clientSecret ||
      !config.appEncryptionKey ||
      !config.databaseUrl
    ) {
      return redirectWithClearedFlow(destination);
    }
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const signedFlow = request.cookies.get("spotify_oauth_flow")?.value;
    if (!code || !state || !signedFlow) return redirectWithClearedFlow(destination);
    const flowId = verifyFlowCookie(signedFlow, config.appEncryptionKey);
    if (!flowId) return redirectWithClearedFlow(destination);

    const connection = createDatabase(config.databaseUrl);
    try {
      const encryptedVerifier = await consumeOAuthState(
        connection.db,
        flowId,
        hashOAuthState(state),
      );
      if (!encryptedVerifier) return redirectWithClearedFlow(destination);
      const verifier = decryptSecret(encryptedVerifier, config.appEncryptionKey);
      const oauth = new SpotifyOAuthClient({
        clientId: config.spotify.clientId,
        clientSecret: config.spotify.clientSecret,
        redirectUri: config.spotify.redirectUri,
      });
      const tokens = await oauth.exchangeCode(code, verifier);
      if (!tokens.refresh_token) throw new Error("Spotify did not return a refresh token");
      const api = new SpotifyClient({ accessToken: () => Promise.resolve(tokens.access_token) });
      const profile = await api.getCurrentUser();
      const userId = await ensureLocalOwner(connection.db);
      await upsertSpotifyAccount(connection.db, {
        accessToken: encryptSecret(tokens.access_token, config.appEncryptionKey),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1_000),
        ...(profile.display_name ? { displayName: profile.display_name } : {}),
        providerAccountId: profile.account_id,
        providerUserId: profile.id,
        refreshToken: encryptSecret(tokens.refresh_token, config.appEncryptionKey),
        scopes: tokens.scope.split(/\s+/).filter(Boolean),
        userId,
      });
      destination.searchParams.set("spotify", "connected");
      const response = NextResponse.redirect(destination);
      response.cookies.delete("spotify_oauth_flow");
      return response;
    } finally {
      await connection.client.end();
    }
  } catch {
    return redirectWithClearedFlow(destination);
  }
}

function redirectWithClearedFlow(destination: URL): NextResponse {
  const response = NextResponse.redirect(destination);
  response.cookies.delete("spotify_oauth_flow");
  return response;
}
