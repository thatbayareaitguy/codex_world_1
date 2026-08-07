import { and, asc, countDistinct, eq, gte, inArray } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artistExternalIds,
  artistFollows,
  artistMappingReviews,
  artistProviderIdentityStatuses,
  artists,
  feedItems,
  trackCredits,
} from "./schema";

export type AppleIdentityImportDecision = "confirm" | "defer" | "split_profile" | "unavailable";

export interface AppleIdentityResolutionBatchRow {
  appleCandidateUrls: string[];
  artistId: string;
  candidateCount: number;
  displayName: string;
  musicBrainzId: string | null;
  resolutionStatus: string;
}

export interface VerifiedAppleIdentityDecision {
  appleArtists: Array<{ id: string; name: string; url: string }>;
  artistId: string;
  decision: AppleIdentityImportDecision;
  suppliedValue: string;
  userNote?: string;
}

export async function listAppleIdentityResolutionBatch(
  db: RadarDatabase,
  limit = 100,
): Promise<AppleIdentityResolutionBatchRow[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const unresolved = await db
    .select({
      artistId: artists.id,
      displayName: artists.name,
      normalizedName: artists.normalizedName,
      resolutionStatus: artistProviderIdentityStatuses.status,
    })
    .from(artistProviderIdentityStatuses)
    .innerJoin(artists, eq(artists.id, artistProviderIdentityStatuses.artistId))
    .innerJoin(artistFollows, eq(artistFollows.artistId, artists.id))
    .where(
      and(
        eq(artistProviderIdentityStatuses.provider, "apple_music"),
        eq(artistProviderIdentityStatuses.status, "requires_manual_decision"),
        eq(artistFollows.active, true),
      ),
    )
    .orderBy(asc(artists.normalizedName), asc(artists.id));
  if (unresolved.length === 0) return [];
  const artistIds = unresolved.map((row) => row.artistId);
  const [candidateRows, musicBrainzRows, recentFeedRows] = await Promise.all([
    db
      .select({
        artistId: artistMappingReviews.artistId,
        externalId: artistMappingReviews.proposedExternalId,
      })
      .from(artistMappingReviews)
      .where(
        and(
          eq(artistMappingReviews.provider, "apple_music"),
          eq(artistMappingReviews.status, "pending"),
          inArray(artistMappingReviews.artistId, artistIds),
        ),
      ),
    db
      .select({ artistId: artistExternalIds.artistId, externalId: artistExternalIds.externalId })
      .from(artistExternalIds)
      .where(
        and(
          eq(artistExternalIds.provider, "musicbrainz"),
          eq(artistExternalIds.confirmed, true),
          inArray(artistExternalIds.artistId, artistIds),
        ),
      ),
    db
      .select({
        artistId: trackCredits.artistId,
        recentItems: countDistinct(feedItems.id),
      })
      .from(trackCredits)
      .innerJoin(feedItems, eq(feedItems.trackId, trackCredits.trackId))
      .where(
        and(
          inArray(trackCredits.artistId, artistIds),
          eq(trackCredits.role, "primary"),
          gte(feedItems.firstSeenAt, new Date(Date.now() - 90 * 86_400_000)),
        ),
      )
      .groupBy(trackCredits.artistId),
  ]);
  const candidatesByArtist = new Map<string, string[]>();
  for (const candidate of candidateRows) {
    if (!candidate.externalId) continue;
    const current = candidatesByArtist.get(candidate.artistId) ?? [];
    current.push(candidate.externalId);
    candidatesByArtist.set(candidate.artistId, current);
  }
  const musicBrainzByArtist = new Map(musicBrainzRows.map((row) => [row.artistId, row.externalId]));
  const recentFeedByArtist = new Map(
    recentFeedRows.map((row) => [row.artistId, Number(row.recentItems)]),
  );
  return unresolved
    .map((row) => {
      const candidateIds = [...new Set(candidatesByArtist.get(row.artistId) ?? [])].sort();
      return {
        appleCandidateUrls: candidateIds.map((id) => `https://music.apple.com/us/artist/${id}`),
        artistId: row.artistId,
        candidateCount: candidateIds.length,
        displayName: row.displayName,
        musicBrainzId: musicBrainzByArtist.get(row.artistId) ?? null,
        normalizedName: row.normalizedName,
        priorityRecentFeedItems: recentFeedByArtist.get(row.artistId) ?? 0,
        resolutionStatus: row.resolutionStatus,
      };
    })
    .sort(
      (left, right) =>
        right.priorityRecentFeedItems - left.priorityRecentFeedItems ||
        Number(Boolean(right.musicBrainzId)) - Number(Boolean(left.musicBrainzId)) ||
        left.candidateCount - right.candidateCount ||
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.artistId.localeCompare(right.artistId),
    )
    .slice(0, boundedLimit)
    .map((row) => ({
      appleCandidateUrls: row.appleCandidateUrls,
      artistId: row.artistId,
      candidateCount: row.candidateCount,
      displayName: row.displayName,
      musicBrainzId: row.musicBrainzId,
      resolutionStatus: row.resolutionStatus,
    }));
}

export async function applyVerifiedAppleIdentityDecisions(
  db: RadarDatabase,
  decisions: VerifiedAppleIdentityDecision[],
): Promise<{ applied: number; unchanged: number }> {
  const artistIds = decisions.map((decision) => decision.artistId);
  if (new Set(artistIds).size !== artistIds.length) {
    throw new Error("The import contains duplicate canonical artist IDs.");
  }
  return db.transaction(async (tx) => {
    let applied = 0;
    let unchanged = 0;
    const now = new Date();
    for (const decision of decisions) {
      const currentStatus = await tx.query.artistProviderIdentityStatuses.findFirst({
        where: and(
          eq(artistProviderIdentityStatuses.artistId, decision.artistId),
          eq(artistProviderIdentityStatuses.provider, "apple_music"),
        ),
      });
      if (!currentStatus) throw new Error("An imported artist lacks Apple identity state.");
      const appleIds = [...new Set(decision.appleArtists.map((artist) => artist.id))];
      validateDecisionShape(decision.decision, appleIds);
      const targetStatus = decisionStatus(decision.decision);
      if (
        currentStatus.status === targetStatus &&
        sameStrings(currentStatus.externalIds, appleIds) &&
        (currentStatus.userNote ?? "") === (decision.userNote ?? "")
      ) {
        unchanged += 1;
        continue;
      }
      if (currentStatus.status !== "requires_manual_decision") {
        throw new Error("An imported artist changed after the CSV was exported.");
      }
      for (const appleId of appleIds) {
        const claimed = await tx.query.artistExternalIds.findFirst({
          where: and(
            eq(artistExternalIds.provider, "apple_music"),
            eq(artistExternalIds.externalId, appleId),
          ),
        });
        if (claimed && claimed.artistId !== decision.artistId) {
          throw new Error("An Apple artist ID is already mapped to another canonical artist.");
        }
      }
      const currentMapping = await tx.query.artistExternalIds.findFirst({
        where: and(
          eq(artistExternalIds.artistId, decision.artistId),
          eq(artistExternalIds.provider, "apple_music"),
        ),
      });
      if (decision.decision !== "confirm" && currentMapping?.confirmed) {
        throw new Error("A non-mapping outcome cannot replace a confirmed Apple identity.");
      }
      if (decision.decision === "confirm") {
        const artist = decision.appleArtists[0]!;
        await tx
          .insert(artistExternalIds)
          .values({
            artistId: decision.artistId,
            confirmed: true,
            confirmedAt: now,
            externalId: artist.id,
            mappingSource: "user_confirmed_apple_music_csv",
            matchReasons: importEvidence(decision),
            matchScore: "1.000",
            provider: "apple_music",
            providerUrl: artist.url,
          })
          .onConflictDoUpdate({
            target: [artistExternalIds.artistId, artistExternalIds.provider],
            set: {
              confirmed: true,
              confirmedAt: currentMapping?.confirmedAt ?? now,
              externalId: artist.id,
              mappingSource: "user_confirmed_apple_music_csv",
              matchReasons: importEvidence(decision),
              matchScore: "1.000",
              providerUrl: artist.url,
              updatedAt: now,
            },
          });
      }
      await tx
        .insert(artistProviderIdentityStatuses)
        .values({
          artistId: decision.artistId,
          decidedAt: now,
          decidedBy: "user",
          evidence: importEvidence(decision),
          externalId: decision.decision === "confirm" ? appleIds[0] : null,
          externalIds: appleIds,
          provider: "apple_music",
          reason: decisionReason(decision.decision),
          status: targetStatus,
          userNote: decision.userNote ?? null,
        })
        .onConflictDoUpdate({
          target: [
            artistProviderIdentityStatuses.artistId,
            artistProviderIdentityStatuses.provider,
          ],
          set: {
            decidedAt: now,
            decidedBy: "user",
            evidence: importEvidence(decision),
            externalId: decision.decision === "confirm" ? appleIds[0] : null,
            externalIds: appleIds,
            linkedArtistId: null,
            reason: decisionReason(decision.decision),
            status: targetStatus,
            updatedAt: now,
            userNote: decision.userNote ?? null,
          },
        });
      await tx
        .update(artistMappingReviews)
        .set({ decidedAt: now, status: "rejected", updatedAt: now })
        .where(
          and(
            eq(artistMappingReviews.artistId, decision.artistId),
            eq(artistMappingReviews.provider, "apple_music"),
            eq(artistMappingReviews.status, "pending"),
          ),
        );
      applied += 1;
    }
    return { applied, unchanged };
  });
}

export async function confirmAppleIdentityFromMusicBrainzEvidence(
  db: RadarDatabase,
  input: {
    appleArtistId: string;
    appleArtistName: string;
    artistId: string;
    evidence: string[];
    exactLinkSource?: "musicbrainz_url" | "wikidata_property";
  },
): Promise<{ idempotent: boolean }> {
  return db.transaction(async (tx) => {
    const claimed = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.provider, "apple_music"),
        eq(artistExternalIds.externalId, input.appleArtistId),
      ),
    });
    if (claimed && claimed.artistId !== input.artistId) {
      throw new Error("The Apple artist ID is already mapped to another canonical artist.");
    }
    const current = await tx.query.artistExternalIds.findFirst({
      where: and(
        eq(artistExternalIds.artistId, input.artistId),
        eq(artistExternalIds.provider, "apple_music"),
      ),
    });
    const idempotent = current?.confirmed === true && current.externalId === input.appleArtistId;
    if (current?.confirmed && !idempotent) {
      throw new Error("MusicBrainz evidence cannot replace a confirmed Apple identity.");
    }
    if (idempotent) return { idempotent: true };
    const now = new Date();
    const url = `https://music.apple.com/us/artist/${input.appleArtistId}`;
    await tx
      .insert(artistExternalIds)
      .values({
        artistId: input.artistId,
        confirmed: true,
        confirmedAt: now,
        externalId: input.appleArtistId,
        mappingSource:
          input.exactLinkSource === "wikidata_property"
            ? "musicbrainz_wikidata_apple_id"
            : input.exactLinkSource === "musicbrainz_url"
              ? "musicbrainz_exact_apple_url"
              : "musicbrainz_catalog_evidence",
        matchReasons: input.evidence,
        matchScore: "1.000",
        provider: "apple_music",
        providerUrl: url,
      })
      .onConflictDoUpdate({
        target: [artistExternalIds.artistId, artistExternalIds.provider],
        set: {
          confirmed: true,
          confirmedAt: current?.confirmedAt ?? now,
          externalId: input.appleArtistId,
          mappingSource:
            input.exactLinkSource === "wikidata_property"
              ? "musicbrainz_wikidata_apple_id"
              : input.exactLinkSource === "musicbrainz_url"
                ? "musicbrainz_exact_apple_url"
                : "musicbrainz_catalog_evidence",
          matchReasons: input.evidence,
          matchScore: "1.000",
          providerUrl: url,
          updatedAt: now,
        },
      });
    await tx
      .insert(artistProviderIdentityStatuses)
      .values({
        artistId: input.artistId,
        decidedAt: now,
        decidedBy: "system",
        evidence: input.evidence,
        externalId: input.appleArtistId,
        externalIds: [input.appleArtistId],
        provider: "apple_music",
        reason: input.exactLinkSource
          ? "An exact independent MusicBrainz link uniquely confirmed the Apple identity."
          : "Independent MusicBrainz catalog evidence uniquely confirmed the Apple identity.",
        status: "automatically_confirmed",
      })
      .onConflictDoUpdate({
        target: [artistProviderIdentityStatuses.artistId, artistProviderIdentityStatuses.provider],
        set: {
          decidedAt: now,
          decidedBy: "system",
          evidence: input.evidence,
          externalId: input.appleArtistId,
          externalIds: [input.appleArtistId],
          linkedArtistId: null,
          reason: input.exactLinkSource
            ? "An exact independent MusicBrainz link uniquely confirmed the Apple identity."
            : "Independent MusicBrainz catalog evidence uniquely confirmed the Apple identity.",
          status: "automatically_confirmed",
          updatedAt: now,
          userNote: null,
        },
      });
    await tx
      .update(artistMappingReviews)
      .set({ decidedAt: now, status: "rejected", updatedAt: now })
      .where(
        and(
          eq(artistMappingReviews.artistId, input.artistId),
          eq(artistMappingReviews.provider, "apple_music"),
          eq(artistMappingReviews.status, "pending"),
        ),
      );
    return { idempotent: false };
  });
}

export async function preserveAppleIdentityExactLinkConflict(
  db: RadarDatabase,
  input: {
    artistId: string;
    candidates: Array<{
      appleArtistId: string;
      appleArtistName: string;
      evidence: string[];
    }>;
    reason: string;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const candidate of input.candidates) {
      await tx
        .insert(artistMappingReviews)
        .values({
          artistId: input.artistId,
          matchReasons: [...candidate.evidence, input.reason],
          matchScore: "1.000",
          proposedExternalId: candidate.appleArtistId,
          provider: "apple_music",
          providerName: candidate.appleArtistName,
        })
        .onConflictDoUpdate({
          target: [
            artistMappingReviews.artistId,
            artistMappingReviews.provider,
            artistMappingReviews.proposedExternalId,
          ],
          set: {
            decidedAt: null,
            matchReasons: [...candidate.evidence, input.reason],
            matchScore: "1.000",
            providerName: candidate.appleArtistName,
            status: "pending",
            updatedAt: now,
          },
        });
    }
    await tx
      .insert(artistProviderIdentityStatuses)
      .values({
        artistId: input.artistId,
        evidence: input.candidates.flatMap((candidate) => candidate.evidence),
        provider: "apple_music",
        reason: input.reason,
        status: "requires_manual_decision",
      })
      .onConflictDoUpdate({
        target: [artistProviderIdentityStatuses.artistId, artistProviderIdentityStatuses.provider],
        set: {
          evidence: input.candidates.flatMap((candidate) => candidate.evidence),
          reason: input.reason,
          status: "requires_manual_decision",
          updatedAt: now,
        },
      });
  });
}

export async function verifyAppleIdentityResolutionState(db: RadarDatabase): Promise<{
  confirmedMappings: number;
  issues: string[];
  pendingCandidates: number;
  unresolvedArtists: number;
}> {
  const [statuses, mappings, pending] = await Promise.all([
    db
      .select()
      .from(artistProviderIdentityStatuses)
      .where(eq(artistProviderIdentityStatuses.provider, "apple_music")),
    db
      .select()
      .from(artistExternalIds)
      .where(
        and(eq(artistExternalIds.provider, "apple_music"), eq(artistExternalIds.confirmed, true)),
      ),
    db
      .select({ artistId: artistMappingReviews.artistId })
      .from(artistMappingReviews)
      .where(
        and(
          eq(artistMappingReviews.provider, "apple_music"),
          eq(artistMappingReviews.status, "pending"),
        ),
      ),
  ]);
  const mappingByArtist = new Map(mappings.map((mapping) => [mapping.artistId, mapping]));
  const pendingByArtist = new Set(pending.map((row) => row.artistId));
  const issues: string[] = [];
  for (const status of statuses) {
    const mapping = mappingByArtist.get(status.artistId);
    if (
      (status.status === "automatically_confirmed" || status.status === "manually_confirmed") &&
      (!mapping || mapping.externalId !== status.externalId)
    ) {
      issues.push(`Confirmed status lacks a matching provider mapping for ${status.artistId}.`);
    }
    if (status.status === "split_profile" && status.externalIds.length < 2) {
      issues.push(`Split-profile status lacks multiple IDs for ${status.artistId}.`);
    }
    if (status.status !== "requires_manual_decision" && pendingByArtist.has(status.artistId)) {
      issues.push(`Resolved status retains pending reviews for ${status.artistId}.`);
    }
  }
  return {
    confirmedMappings: mappings.length,
    issues,
    pendingCandidates: pending.length,
    unresolvedArtists: new Set(pending.map((row) => row.artistId)).size,
  };
}

function validateDecisionShape(decision: AppleIdentityImportDecision, appleIds: string[]): void {
  if (decision === "confirm" && appleIds.length !== 1) {
    throw new Error("A confirmed mapping requires exactly one Apple artist ID.");
  }
  if (decision === "split_profile" && appleIds.length < 2) {
    throw new Error("A split-profile decision requires at least two Apple artist IDs.");
  }
  if ((decision === "defer" || decision === "unavailable") && appleIds.length !== 0) {
    throw new Error("Deferred and unavailable decisions cannot include Apple artist IDs.");
  }
}

function decisionStatus(decision: AppleIdentityImportDecision) {
  if (decision === "confirm") return "manually_confirmed" as const;
  if (decision === "split_profile") return "split_profile" as const;
  if (decision === "defer") return "intentionally_deferred" as const;
  return "confirmed_unavailable" as const;
}

function decisionReason(decision: AppleIdentityImportDecision): string {
  if (decision === "confirm") return "User confirmed an exact Apple Music artist identity.";
  if (decision === "split_profile") {
    return "User confirmed that the artist catalog is split across Apple Music profiles.";
  }
  if (decision === "defer") return "User intentionally deferred this Apple Music identity.";
  return "User confirmed that this artist is unavailable on Apple Music.";
}

function importEvidence(decision: VerifiedAppleIdentityDecision): string[] {
  const evidence = ["Validated Apple Music identity CSV import"];
  if (decision.suppliedValue) evidence.push(`User input: ${decision.suppliedValue}`);
  for (const artist of decision.appleArtists) {
    evidence.push(`Apple API verified artist ${artist.id}: ${artist.name}`);
  }
  if (decision.userNote) evidence.push(`User note: ${decision.userNote}`);
  return evidence;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}
