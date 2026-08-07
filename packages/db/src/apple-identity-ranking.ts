import { createHash } from "node:crypto";
import type { AppleIdentityCandidateCatalog, AppleIdentityCandidateRanking } from "@radar/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  appleIdentityCandidateCatalogs,
  appleIdentityCandidateRankings,
  artistExternalIds,
  artistMappingReviews,
  artistProviderIdentityStatuses,
} from "./schema";

export const appleIdentityCalibrationVersion = "apple-only-v1";

export interface AppleIdentityRankingWorkItem {
  artistId: string;
  candidates: Array<{
    appleArtistId: string;
    catalog?: AppleIdentityCandidateCatalog;
    claimedByOtherCanonicalArtist: boolean;
  }>;
}

export async function persistAppleIdentityCandidateCatalog(
  db: RadarDatabase,
  input: {
    catalog: AppleIdentityCandidateCatalog;
    errorClassification?: string;
    fetchedAt?: Date;
    requestIdentity: string;
  },
): Promise<void> {
  const fetchedAt = input.fetchedAt ?? new Date();
  const responseHash = createHash("sha256").update(JSON.stringify(input.catalog)).digest("hex");
  await db
    .insert(appleIdentityCandidateCatalogs)
    .values({
      appleArtistId: input.catalog.appleArtistId,
      catalog: input.catalog,
      ...(input.errorClassification ? { errorClassification: input.errorClassification } : {}),
      fetchedAt,
      requestIdentity: input.requestIdentity,
      resourceStatus: input.catalog.resourceStatus,
      responseHash,
      source: input.catalog.source,
    })
    .onConflictDoUpdate({
      target: appleIdentityCandidateCatalogs.appleArtistId,
      set: {
        catalog: input.catalog,
        errorClassification: input.errorClassification ?? null,
        fetchedAt,
        requestIdentity: input.requestIdentity,
        resourceStatus: input.catalog.resourceStatus,
        responseHash,
        source: input.catalog.source,
        updatedAt: fetchedAt,
      },
    });
}

export async function persistAppleIdentityCandidateRankings(
  db: RadarDatabase,
  artistId: string,
  rankings: AppleIdentityCandidateRanking[],
  exactLinkSources: ReadonlyMap<string, "musicbrainz_url" | "wikidata_property"> = new Map(),
  rankedAt = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(appleIdentityCandidateRankings)
      .where(eq(appleIdentityCandidateRankings.artistId, artistId));
    if (!rankings.length) return;
    await tx.insert(appleIdentityCandidateRankings).values(
      rankings.map((ranking) => ({
        appleArtistId: ranking.appleArtistId,
        artistId,
        autoConfirmEligible: ranking.autoConfirmEligible,
        calibrationVersion: appleIdentityCalibrationVersion,
        contradictions: ranking.contradictions,
        eliminationSafe: ranking.eliminationSafe,
        exactLinkSource: exactLinkSources.get(ranking.appleArtistId),
        rank: ranking.rank,
        rankedAt,
        reasons: ranking.reasons,
        score: ranking.score.toFixed(3),
        signals: ranking.signals,
        titleOverlaps: ranking.titleOverlaps,
      })),
    );
  });
}

export async function loadAppleIdentityRankingWork(
  db: RadarDatabase,
  options: { artistLimit: number; includeResolvedTruth?: boolean },
): Promise<AppleIdentityRankingWorkItem[]> {
  const statuses = await db
    .select({ artistId: artistProviderIdentityStatuses.artistId })
    .from(artistProviderIdentityStatuses)
    .where(
      and(
        eq(artistProviderIdentityStatuses.provider, "apple_music"),
        options.includeResolvedTruth
          ? inArray(artistProviderIdentityStatuses.status, [
              "automatically_confirmed",
              "manually_confirmed",
            ])
          : eq(artistProviderIdentityStatuses.status, "requires_manual_decision"),
      ),
    )
    .orderBy(asc(artistProviderIdentityStatuses.artistId))
    .limit(Math.max(1, Math.min(Math.trunc(options.artistLimit), 500)));
  const artistIds = statuses.map((row) => row.artistId);
  if (!artistIds.length) return [];
  const reviews = await db
    .select({
      appleArtistId: artistMappingReviews.proposedExternalId,
      artistId: artistMappingReviews.artistId,
    })
    .from(artistMappingReviews)
    .where(
      and(
        eq(artistMappingReviews.provider, "apple_music"),
        inArray(artistMappingReviews.artistId, artistIds),
      ),
    );
  const candidateIds = [
    ...new Set(
      reviews
        .map((review) => review.appleArtistId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const [catalogRows, confirmedRows] = await Promise.all([
    candidateIds.length
      ? db
          .select()
          .from(appleIdentityCandidateCatalogs)
          .where(inArray(appleIdentityCandidateCatalogs.appleArtistId, candidateIds))
      : [],
    candidateIds.length
      ? db
          .select({
            appleArtistId: artistExternalIds.externalId,
            artistId: artistExternalIds.artistId,
          })
          .from(artistExternalIds)
          .where(
            and(
              eq(artistExternalIds.provider, "apple_music"),
              eq(artistExternalIds.confirmed, true),
              inArray(artistExternalIds.externalId, candidateIds),
            ),
          )
      : [],
  ]);
  const catalogById = new Map(catalogRows.map((row) => [row.appleArtistId, row.catalog]));
  const claimedById = new Map(confirmedRows.map((row) => [row.appleArtistId, row.artistId]));
  return artistIds.map((artistId) => ({
    artistId,
    candidates: reviews
      .filter((review) => review.artistId === artistId && review.appleArtistId)
      .map((review) => ({
        appleArtistId: review.appleArtistId!,
        ...(catalogById.get(review.appleArtistId!)
          ? { catalog: catalogById.get(review.appleArtistId!)! }
          : {}),
        claimedByOtherCanonicalArtist:
          Boolean(claimedById.get(review.appleArtistId!)) &&
          claimedById.get(review.appleArtistId!) !== artistId,
      })),
  }));
}

export async function listAppleIdentityTruthGroups(
  db: RadarDatabase,
): Promise<Array<{ artistId: string; candidateIds: string[]; trueAppleArtistId: string }>> {
  const mappings = await db
    .select({
      artistId: artistExternalIds.artistId,
      trueAppleArtistId: artistExternalIds.externalId,
    })
    .from(artistExternalIds)
    .where(
      and(eq(artistExternalIds.provider, "apple_music"), eq(artistExternalIds.confirmed, true)),
    );
  const artistIds = mappings.map((mapping) => mapping.artistId);
  if (!artistIds.length) return [];
  const reviews = await db
    .select({
      appleArtistId: artistMappingReviews.proposedExternalId,
      artistId: artistMappingReviews.artistId,
    })
    .from(artistMappingReviews)
    .where(
      and(
        eq(artistMappingReviews.provider, "apple_music"),
        inArray(artistMappingReviews.artistId, artistIds),
      ),
    );
  return mappings
    .map((mapping) => ({
      artistId: mapping.artistId,
      candidateIds: [
        ...new Set(
          reviews
            .filter((review) => review.artistId === mapping.artistId && review.appleArtistId)
            .map((review) => review.appleArtistId!),
        ),
      ],
      trueAppleArtistId: mapping.trueAppleArtistId,
    }))
    .filter((group) => group.candidateIds.includes(group.trueAppleArtistId));
}

export async function listPersistedAppleIdentityCatalogs(
  db: RadarDatabase,
  appleArtistIds?: string[],
): Promise<AppleIdentityCandidateCatalog[]> {
  if (appleArtistIds && !appleArtistIds.length) return [];
  const rows = appleArtistIds
    ? await db
        .select({ catalog: appleIdentityCandidateCatalogs.catalog })
        .from(appleIdentityCandidateCatalogs)
        .where(inArray(appleIdentityCandidateCatalogs.appleArtistId, appleArtistIds))
    : await db
        .select({ catalog: appleIdentityCandidateCatalogs.catalog })
        .from(appleIdentityCandidateCatalogs);
  return rows.map((row) => row.catalog);
}
