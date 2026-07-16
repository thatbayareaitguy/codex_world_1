import { normalizeText } from "@radar/core";
import type { EncryptedValue, SpotifyImportPreviewItem } from "@radar/providers";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artistExternalIds,
  artistFollows,
  artistImportCandidates,
  artistImportRuns,
  artists,
  oauthAccounts,
  oauthStates,
  users,
} from "./schema";

export const LOCAL_OWNER_EMAIL = "owner@local.invalid";

export async function ensureLocalOwner(db: RadarDatabase): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ displayName: "Local owner", email: LOCAL_OWNER_EMAIL })
    .onConflictDoUpdate({
      target: users.email,
      set: { displayName: "Local owner", updatedAt: new Date() },
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("Failed to create the local owner");
  return owner.id;
}

export async function persistOAuthState(
  db: RadarDatabase,
  input: {
    encryptedVerifier: EncryptedValue;
    expiresAt: Date;
    stateHash: string;
    userId: string;
  },
): Promise<string> {
  const [state] = await db
    .insert(oauthStates)
    .values({
      encryptedCodeVerifier: input.encryptedVerifier.ciphertext,
      expiresAt: input.expiresAt,
      provider: "spotify",
      stateHash: input.stateHash,
      userId: input.userId,
      verifierNonce: input.encryptedVerifier.nonce,
    })
    .returning({ id: oauthStates.id });
  if (!state) throw new Error("Failed to persist OAuth state");
  return state.id;
}

export async function consumeOAuthState(
  db: RadarDatabase,
  id: string,
  stateHash: string,
  now = new Date(),
): Promise<EncryptedValue | undefined> {
  const [state] = await db
    .update(oauthStates)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthStates.id, id),
        eq(oauthStates.provider, "spotify"),
        eq(oauthStates.stateHash, stateHash),
        isNull(oauthStates.usedAt),
        gt(oauthStates.expiresAt, now),
      ),
    )
    .returning({
      ciphertext: oauthStates.encryptedCodeVerifier,
      nonce: oauthStates.verifierNonce,
    });
  return state;
}

export interface SpotifyAccountPersistence {
  accessToken: EncryptedValue;
  accessTokenExpiresAt: Date;
  displayName?: string;
  providerAccountId: string;
  providerUserId?: string;
  refreshToken: EncryptedValue;
  scopes: string[];
  userId: string;
}

export async function upsertSpotifyAccount(
  db: RadarDatabase,
  account: SpotifyAccountPersistence,
): Promise<string> {
  const [stored] = await db
    .insert(oauthAccounts)
    .values({
      accessTokenExpiresAt: account.accessTokenExpiresAt,
      accessTokenNonce: account.accessToken.nonce,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      disconnectedAt: null,
      encryptedAccessToken: account.accessToken.ciphertext,
      encryptedRefreshToken: account.refreshToken.ciphertext,
      keyVersion: 1,
      lastTokenRefreshAt: new Date(),
      provider: "spotify",
      providerAccountId: account.providerAccountId,
      ...(account.providerUserId ? { providerUserId: account.providerUserId } : {}),
      reconnectRequired: false,
      scopes: account.scopes,
      tokenNonce: account.refreshToken.nonce,
      userId: account.userId,
    })
    .onConflictDoUpdate({
      target: [oauthAccounts.provider, oauthAccounts.providerAccountId],
      set: {
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        accessTokenNonce: account.accessToken.nonce,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        disconnectedAt: null,
        encryptedAccessToken: account.accessToken.ciphertext,
        encryptedRefreshToken: account.refreshToken.ciphertext,
        lastTokenRefreshAt: new Date(),
        ...(account.providerUserId ? { providerUserId: account.providerUserId } : {}),
        reconnectRequired: false,
        scopes: account.scopes,
        tokenNonce: account.refreshToken.nonce,
        updatedAt: new Date(),
      },
    })
    .returning({ id: oauthAccounts.id });
  if (!stored) throw new Error("Failed to persist Spotify account");
  return stored.id;
}

export async function disconnectSpotifyAccount(db: RadarDatabase, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(artistImportRuns).where(eq(artistImportRuns.userId, userId));
    await tx
      .update(oauthAccounts)
      .set({
        accessTokenExpiresAt: null,
        accessTokenNonce: null,
        disconnectedAt: new Date(),
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        reconnectRequired: false,
        tokenNonce: null,
        updatedAt: new Date(),
      })
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "spotify")));
  });
}

export async function createSpotifyImportRun(
  db: RadarDatabase,
  userId: string,
  preview: SpotifyImportPreviewItem[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(artistImportRuns)
      .values({ provider: "spotify", retrievedCount: preview.length, userId })
      .returning({ id: artistImportRuns.id });
    if (!run) throw new Error("Failed to create Spotify import preview");
    if (preview.length) {
      await tx.insert(artistImportCandidates).values(
        preview.map((item) => ({
          ...(item.existingArtistId ? { existingArtistId: item.existingArtistId } : {}),
          importRunId: run.id,
          proposedAction: item.proposedAction,
          providerArtistId: item.providerArtistId,
          providerName: item.providerName,
          providerUrl: item.providerUrl,
          selected: item.selected,
        })),
      );
    }
    return run.id;
  });
}

export interface ImportDecision {
  candidateId: string;
  decision: "create" | "merge" | "skip";
  existingArtistId?: string;
  selected: boolean;
}

export async function confirmSpotifyImport(
  db: RadarDatabase,
  userId: string,
  importRunId: string,
  decisions: ImportDecision[],
): Promise<{ created: number; merged: number; needsReview: number; skipped: number }> {
  return db.transaction(async (tx) => {
    const summary = { created: 0, merged: 0, needsReview: 0, skipped: 0 };
    const candidates = await tx.query.artistImportCandidates.findMany({
      where: eq(artistImportCandidates.importRunId, importRunId),
    });
    for (const candidate of candidates) {
      const decision = decisions.find((item) => item.candidateId === candidate.id);
      if (!decision?.selected || decision.decision === "skip") {
        summary.skipped += 1;
        continue;
      }

      const existingMapping = await tx.query.artistExternalIds.findFirst({
        where: and(
          eq(artistExternalIds.provider, "spotify"),
          eq(artistExternalIds.externalId, candidate.providerArtistId),
        ),
        columns: { artistId: true },
      });
      let artistId =
        existingMapping?.artistId ??
        decision.existingArtistId ??
        candidate.existingArtistId ??
        undefined;
      if (existingMapping) {
        summary.merged += 1;
      } else if (decision.decision === "create") {
        const [created] = await tx
          .insert(artists)
          .values({
            name: candidate.providerName,
            normalizedName: normalizeText(candidate.providerName),
          })
          .returning({ id: artists.id });
        if (!created) throw new Error("Failed to create imported canonical artist");
        artistId = created.id;
        summary.created += 1;
      } else if (artistId) {
        summary.merged += 1;
      } else {
        summary.needsReview += 1;
        continue;
      }
      if (!artistId) throw new Error("Import decision did not resolve a canonical artist");
      const resolvedArtistId = artistId;

      await tx
        .insert(artistExternalIds)
        .values({
          artistId: resolvedArtistId,
          confirmed: true,
          confirmedAt: new Date(),
          externalId: candidate.providerArtistId,
          importedAt: new Date(),
          mappingSource: "spotify_follow_import",
          matchReasons: ["User approved followed-artist import"],
          matchScore: "1.000",
          provider: "spotify",
          providerUrl: candidate.providerUrl,
        })
        .onConflictDoUpdate({
          target: [artistExternalIds.provider, artistExternalIds.externalId],
          set: {
            artistId: resolvedArtistId,
            confirmed: true,
            confirmedAt: new Date(),
            importedAt: new Date(),
            mappingSource: "spotify_follow_import",
            updatedAt: new Date(),
          },
        });
      await tx
        .insert(artistFollows)
        .values({ artistId: resolvedArtistId, source: "spotify_import", userId })
        .onConflictDoUpdate({
          target: [artistFollows.userId, artistFollows.artistId],
          set: { active: true, source: "spotify_import" },
        });
    }
    await tx
      .update(artistImportRuns)
      .set({
        completedAt: new Date(),
        createdCount: summary.created,
        mergedCount: summary.merged,
        reviewCount: summary.needsReview,
        skippedCount: summary.skipped,
        status: "completed",
      })
      .where(and(eq(artistImportRuns.id, importRunId), eq(artistImportRuns.userId, userId)));
    return summary;
  });
}
