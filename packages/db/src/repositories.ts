import { normalizeText } from "@radar/core";
import type { EncryptedValue, SpotifyImportPreviewItem } from "@radar/providers";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
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

export interface FollowedArtistRecord {
  active: boolean;
  artistId: string;
  followedAt: Date;
  name: string;
  providers: Array<(typeof artistExternalIds.$inferSelect)["provider"]>;
  source: string;
}

export async function listFollowedArtists(
  db: RadarDatabase,
  userId: string,
): Promise<FollowedArtistRecord[]> {
  const followed = await db
    .select({
      active: artistFollows.active,
      artistId: artists.id,
      followedAt: artistFollows.followedAt,
      name: artists.name,
      source: artistFollows.source,
    })
    .from(artistFollows)
    .innerJoin(artists, eq(artists.id, artistFollows.artistId))
    .where(eq(artistFollows.userId, userId))
    .orderBy(desc(artistFollows.followedAt), artists.name);

  if (!followed.length) return [];

  const mappings = await db
    .select({ artistId: artistExternalIds.artistId, provider: artistExternalIds.provider })
    .from(artistExternalIds)
    .where(
      inArray(
        artistExternalIds.artistId,
        followed.map((artist) => artist.artistId),
      ),
    );
  const providersByArtist = new Map<string, FollowedArtistRecord["providers"]>();
  for (const mapping of mappings) {
    const providers = providersByArtist.get(mapping.artistId) ?? [];
    if (!providers.includes(mapping.provider)) providers.push(mapping.provider);
    providersByArtist.set(mapping.artistId, providers);
  }

  return followed.map((artist) => ({
    ...artist,
    providers: providersByArtist.get(artist.artistId) ?? [],
  }));
}

export interface ImportDecision {
  candidateId: string;
  decision: "create" | "merge" | "skip";
  existingArtistId?: string;
  selected: boolean;
}

export interface SpotifyImportSummary {
  alreadyPresent: number;
  created: number;
  failed: number;
  merged: number;
  needsReview: number;
  persisted: number;
  retrieved: number;
  selected: number;
  skipped: number;
}

export async function confirmSpotifyImport(
  db: RadarDatabase,
  userId: string,
  importRunId: string,
  decisions: ImportDecision[],
): Promise<SpotifyImportSummary> {
  return db.transaction(async (tx) => {
    const importRun = await tx.query.artistImportRuns.findFirst({
      where: and(
        eq(artistImportRuns.id, importRunId),
        eq(artistImportRuns.userId, userId),
        eq(artistImportRuns.provider, "spotify"),
      ),
    });
    if (!importRun) throw new Error("Spotify import batch does not belong to the local user");

    const candidates = await tx.query.artistImportCandidates.findMany({
      where: eq(artistImportCandidates.importRunId, importRunId),
    });
    if (importRun.status !== "preview") {
      const selected = candidates.filter(
        (candidate) => candidate.selected && candidate.decision !== "skip",
      ).length;
      const persisted = (
        await tx
          .select({ artistId: artistFollows.artistId })
          .from(artistFollows)
          .where(and(eq(artistFollows.userId, userId), eq(artistFollows.active, true)))
      ).length;
      return {
        alreadyPresent: Math.max(
          0,
          selected - importRun.createdCount - importRun.mergedCount - importRun.reviewCount,
        ),
        created: importRun.createdCount,
        failed: importRun.failedCount,
        merged: importRun.mergedCount,
        needsReview: importRun.reviewCount,
        persisted,
        retrieved: importRun.retrievedCount,
        selected,
        skipped: importRun.skippedCount,
      };
    }

    const decisionByCandidate = new Map(
      decisions.map((decision) => [decision.candidateId, decision]),
    );
    if (decisionByCandidate.size !== decisions.length || decisions.length !== candidates.length) {
      throw new Error("Every import candidate requires exactly one decision");
    }
    if (candidates.some((candidate) => !decisionByCandidate.has(candidate.id))) {
      throw new Error("Import decisions contain a candidate from another batch");
    }

    const summary: SpotifyImportSummary = {
      alreadyPresent: 0,
      created: 0,
      failed: 0,
      merged: 0,
      needsReview: 0,
      persisted: 0,
      retrieved: importRun.retrievedCount,
      selected: decisions.filter((decision) => decision.selected && decision.decision !== "skip")
        .length,
      skipped: 0,
    };
    if (summary.selected === 0) {
      throw new Error("Select at least one artist before confirming the import");
    }

    for (const candidate of candidates) {
      const decision = decisionByCandidate.get(candidate.id);
      if (!decision) throw new Error("Import candidate decision is missing");
      await tx
        .update(artistImportCandidates)
        .set({
          decision: decision.decision,
          ...(decision.existingArtistId ? { existingArtistId: decision.existingArtistId } : {}),
          selected: decision.selected,
        })
        .where(eq(artistImportCandidates.id, candidate.id));

      if (!decision.selected || decision.decision === "skip") {
        if (candidate.proposedAction === "review") summary.needsReview += 1;
        else summary.skipped += 1;
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
        const existingFollow = await tx.query.artistFollows.findFirst({
          where: and(
            eq(artistFollows.userId, userId),
            eq(artistFollows.artistId, existingMapping.artistId),
          ),
          columns: { active: true },
        });
        if (existingFollow?.active) summary.alreadyPresent += 1;
        else summary.merged += 1;
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
          set: { active: true },
        });
    }
    summary.persisted = (
      await tx
        .select({ artistId: artistFollows.artistId })
        .from(artistFollows)
        .where(and(eq(artistFollows.userId, userId), eq(artistFollows.active, true)))
    ).length;
    await tx
      .update(artistImportRuns)
      .set({
        completedAt: new Date(),
        createdCount: summary.created,
        mergedCount: summary.merged,
        failedCount: summary.failed,
        reviewCount: summary.needsReview,
        skippedCount: summary.skipped,
        status: summary.needsReview || summary.failed ? "partial" : "completed",
      })
      .where(and(eq(artistImportRuns.id, importRunId), eq(artistImportRuns.userId, userId)));
    return summary;
  });
}
