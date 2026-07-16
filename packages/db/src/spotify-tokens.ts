import {
  decryptSecret,
  encryptSecret,
  SpotifyHttpError,
  type SpotifyOAuthClient,
  type SpotifyTokenResponse,
} from "@radar/providers";
import { and, eq } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { oauthAccounts } from "./schema";

export class SpotifyTokenManager {
  constructor(
    private readonly db: RadarDatabase,
    private readonly userId: string,
    private readonly applicationKey: string,
    private readonly oauthClient: SpotifyOAuthClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAccessToken(): Promise<string> {
    const account = await this.account();
    if (
      account.encryptedAccessToken &&
      account.accessTokenNonce &&
      account.accessTokenExpiresAt &&
      account.accessTokenExpiresAt.getTime() > this.now().getTime() + 60_000
    ) {
      return decryptSecret(
        { ciphertext: account.encryptedAccessToken, nonce: account.accessTokenNonce },
        this.applicationKey,
      );
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const account = await this.account();
    if (!account.encryptedRefreshToken || !account.tokenNonce) {
      throw new Error("Spotify reconnect is required");
    }
    const refreshToken = decryptSecret(
      { ciphertext: account.encryptedRefreshToken, nonce: account.tokenNonce },
      this.applicationKey,
    );
    try {
      const response = await this.oauthClient.refresh(refreshToken);
      await this.persistRefresh(account.id, refreshToken, response);
      return response.access_token;
    } catch (error) {
      if (error instanceof SpotifyHttpError && (error.status === 400 || error.status === 401)) {
        await this.db
          .update(oauthAccounts)
          .set({ reconnectRequired: true, updatedAt: this.now() })
          .where(eq(oauthAccounts.id, account.id));
      }
      throw error;
    }
  }

  private async account() {
    const account = await this.db.query.oauthAccounts.findFirst({
      where: and(eq(oauthAccounts.userId, this.userId), eq(oauthAccounts.provider, "spotify")),
    });
    if (!account || account.disconnectedAt || account.reconnectRequired) {
      throw new Error("Spotify reconnect is required");
    }
    return account;
  }

  private async persistRefresh(
    accountId: string,
    previousRefreshToken: string,
    response: SpotifyTokenResponse,
  ): Promise<void> {
    const access = encryptSecret(response.access_token, this.applicationKey);
    const refresh = encryptSecret(
      response.refresh_token ?? previousRefreshToken,
      this.applicationKey,
    );
    await this.db
      .update(oauthAccounts)
      .set({
        accessTokenExpiresAt: new Date(this.now().getTime() + response.expires_in * 1_000),
        accessTokenNonce: access.nonce,
        encryptedAccessToken: access.ciphertext,
        encryptedRefreshToken: refresh.ciphertext,
        lastTokenRefreshAt: this.now(),
        reconnectRequired: false,
        scopes: response.scope.split(/\s+/).filter(Boolean),
        tokenNonce: refresh.nonce,
        updatedAt: this.now(),
      })
      .where(eq(oauthAccounts.id, accountId));
  }
}
