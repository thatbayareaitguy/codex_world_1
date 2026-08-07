import {
  buildAppleIdentityGenreFrequency,
  calibrateAppleIdentityRankings,
  rankAppleIdentityCandidates,
  type AppleIdentityCalibrationResult,
  type AppleIdentityCandidateCatalog,
} from "@radar/core";
import {
  artistExternalIds,
  confirmAppleIdentityFromMusicBrainzEvidence,
  listAppleIdentityTruthGroups,
  listPersistedAppleIdentityCatalogs,
  loadAppleIdentityRankingWork,
  persistAppleIdentityCandidateCatalog,
  persistAppleIdentityCandidateRankings,
  preserveAppleIdentityExactLinkConflict,
  type AppleIdentityResolutionBatchRow,
  type RadarDatabase,
} from "@radar/db";
import {
  type AppleIdentityCatalogClient,
  type MusicBrainzArtistUrlRelationship,
  type MusicBrainzClient,
} from "@radar/providers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export interface AppleIdentityResolutionRunResult {
  automaticallyResolvedArtists: number;
  calibration: AppleIdentityCalibrationResult & {
    confirmedMappings: number;
    reconstructableTruthGroups: number;
  };
  catalogsFetched: number;
  catalogsReused: number;
  collaborationSupportedResolutions: number;
  directMusicBrainzMatches: number;
  eliminatedCandidates: number;
  failures: Array<{ artistId?: string; appleArtistId?: string; classification: string }>;
  appleFamilyRequests: number;
  remainingManualArtists: number;
  rankedArtists: number;
  splitProfileConflicts: number;
  titleOverlapResolutions: number;
  wikidataMatches: number;
  wikidataRequests: number;
}

export async function runAppleIdentityResolution(input: {
  artistLimit: number;
  catalogClient: AppleIdentityCatalogClient;
  db: RadarDatabase;
  maxCatalogs: number;
  musicBrainzClient?: Pick<MusicBrainzClient, "lookupArtistUrlRelationships">;
  rows: AppleIdentityResolutionBatchRow[];
  wikidataFetch?: typeof fetch;
}): Promise<AppleIdentityResolutionRunResult> {
  const failures: AppleIdentityResolutionRunResult["failures"] = [];
  const exactLinksByArtist = new Map<
    string,
    Map<string, "musicbrainz_url" | "wikidata_property">
  >();
  const catalogById = new Map(
    (await listPersistedAppleIdentityCatalogs(input.db)).map((catalog) => [
      catalog.appleArtistId,
      catalog,
    ]),
  );
  const confirmedMappings = await input.db
    .select({ appleArtistId: artistExternalIds.externalId, artistId: artistExternalIds.artistId })
    .from(artistExternalIds)
    .where(
      and(eq(artistExternalIds.provider, "apple_music"), eq(artistExternalIds.confirmed, true)),
    );
  const claimedById = new Map(
    confirmedMappings.map((mapping) => [mapping.appleArtistId, mapping.artistId]),
  );
  const truthGroups = await listAppleIdentityTruthGroups(input.db);
  const unresolvedWork = await loadAppleIdentityRankingWork(input.db, {
    artistLimit: input.artistLimit,
  });
  let catalogsFetched = 0;
  let catalogsReused = 0;
  let directMusicBrainzMatches = 0;
  let wikidataMatches = 0;
  let wikidataRequests = 0;
  let splitProfileConflicts = 0;
  let automaticallyResolvedArtists = 0;

  const ensureCatalog = async (
    appleArtistId: string,
    artistId?: string,
  ): Promise<AppleIdentityCandidateCatalog | undefined> => {
    const existing = catalogById.get(appleArtistId);
    if (existing) {
      catalogsReused += 1;
      return existing;
    }
    if (catalogsFetched >= input.maxCatalogs) return undefined;
    try {
      const catalog = await input.catalogClient.getArtistCatalog(appleArtistId);
      await persistAppleIdentityCandidateCatalog(input.db, {
        catalog,
        requestIdentity: catalogRequestIdentity(catalog),
      });
      catalogById.set(appleArtistId, catalog);
      catalogsFetched += 1;
      return catalog;
    } catch (error) {
      failures.push({
        ...(artistId ? { artistId } : {}),
        appleArtistId,
        classification: safeClassification(error),
      });
      return undefined;
    }
  };

  for (const appleArtistId of [...new Set(truthGroups.flatMap((group) => group.candidateIds))]) {
    if (catalogsFetched >= input.maxCatalogs) break;
    await ensureCatalog(appleArtistId);
  }
  const preflightContext = rankingContext(claimedById, catalogById);
  const preflightCalibration = calibrateAppleIdentityRankings(
    truthGroups.map((group) => ({
      candidates: rankAppleIdentityCandidates(
        group.candidateIds.map((appleArtistId) => ({
          ...(catalogById.get(appleArtistId) ? { catalog: catalogById.get(appleArtistId)! } : {}),
          claimedByOtherCanonicalArtist:
            Boolean(claimedById.get(appleArtistId)) &&
            claimedById.get(appleArtistId) !== group.artistId,
          proposedAppleArtistId: appleArtistId,
        })),
        preflightContext,
      ),
      trueAppleArtistId: group.trueAppleArtistId,
    })),
  );
  const calibrationSafetyVerified =
    preflightCalibration.groups > 0 &&
    preflightCalibration.falseConfirmations === 0 &&
    preflightCalibration.trueCandidatesEliminated === 0;

  if (input.musicBrainzClient) {
    for (const row of input.rows.filter((candidate) => candidate.musicBrainzId)) {
      try {
        const relationships = await input.musicBrainzClient.lookupArtistUrlRelationships(
          row.musicBrainzId!,
        );
        const exact = new Map<string, "musicbrainz_url" | "wikidata_property">(
          collectDirectAppleLinks(relationships),
        );
        const wikidataIds = collectWikidataIds(relationships);
        for (const wikidataId of wikidataIds) {
          wikidataRequests += 1;
          try {
            for (const appleArtistId of await fetchWikidataAppleArtistIds(
              wikidataId,
              input.wikidataFetch ?? fetch,
            )) {
              if (!exact.has(appleArtistId)) exact.set(appleArtistId, "wikidata_property");
            }
          } catch (error) {
            failures.push({ artistId: row.artistId, classification: safeClassification(error) });
          }
        }
        if (!exact.size) continue;
        const valid: Array<{
          appleArtistId: string;
          appleArtistName: string;
          source: "musicbrainz_url" | "wikidata_property";
        }> = [];
        for (const [appleArtistId, source] of exact) {
          const catalog = await ensureCatalog(appleArtistId, row.artistId);
          if (catalog?.resourceStatus !== "valid") continue;
          valid.push({ appleArtistId, appleArtistName: catalog.artistName, source });
        }
        if (!valid.length) continue;
        exactLinksByArtist.set(
          row.artistId,
          new Map(valid.map((candidate) => [candidate.appleArtistId, candidate.source])),
        );
        if (valid.length > 1) {
          splitProfileConflicts += 1;
          await preserveAppleIdentityExactLinkConflict(input.db, {
            artistId: row.artistId,
            candidates: valid.map((candidate) => ({
              appleArtistId: candidate.appleArtistId,
              appleArtistName: candidate.appleArtistName,
              evidence: [exactEvidence(candidate.source, row.musicBrainzId!)],
            })),
            reason:
              "Multiple exact independent links identify different Apple artist profiles; explicit split-profile review is required.",
          });
          continue;
        }
        const winner = valid[0]!;
        if (
          claimedById.has(winner.appleArtistId) &&
          claimedById.get(winner.appleArtistId) !== row.artistId
        ) {
          await preserveAppleIdentityExactLinkConflict(input.db, {
            artistId: row.artistId,
            candidates: [
              {
                appleArtistId: winner.appleArtistId,
                appleArtistName: winner.appleArtistName,
                evidence: [exactEvidence(winner.source, row.musicBrainzId!)],
              },
            ],
            reason:
              "The exact Apple artist ID is already confirmed for another canonical artist; automatic confirmation is blocked.",
          });
          continue;
        }
        if (!calibrationSafetyVerified) {
          await preserveAppleIdentityExactLinkConflict(input.db, {
            artistId: row.artistId,
            candidates: [
              {
                appleArtistId: winner.appleArtistId,
                appleArtistName: winner.appleArtistName,
                evidence: [exactEvidence(winner.source, row.musicBrainzId!)],
              },
            ],
            reason:
              "The exact link is preserved for review because the Apple-only calibration safety gate was not proven.",
          });
          continue;
        }
        await confirmAppleIdentityFromMusicBrainzEvidence(input.db, {
          appleArtistId: winner.appleArtistId,
          appleArtistName: winner.appleArtistName,
          artistId: row.artistId,
          evidence: [exactEvidence(winner.source, row.musicBrainzId!)],
          exactLinkSource: winner.source,
        });
        automaticallyResolvedArtists += 1;
        if (winner.source === "musicbrainz_url") directMusicBrainzMatches += 1;
        else wikidataMatches += 1;
        claimedById.set(winner.appleArtistId, row.artistId);
      } catch (error) {
        failures.push({ artistId: row.artistId, classification: safeClassification(error) });
      }
    }
  }

  const prioritizedIds = [
    ...new Set([
      ...unresolvedWork.flatMap((work) =>
        work.candidates.map((candidate) => candidate.appleArtistId),
      ),
    ]),
  ];
  for (const appleArtistId of prioritizedIds) {
    if (catalogsFetched >= input.maxCatalogs) break;
    await ensureCatalog(appleArtistId);
  }

  const context = rankingContext(claimedById, catalogById);
  let rankedArtists = 0;
  let eliminatedCandidates = 0;
  for (const work of unresolvedWork) {
    const sources =
      exactLinksByArtist.get(work.artistId) ??
      new Map<string, "musicbrainz_url" | "wikidata_property">();
    const rankings = rankAppleIdentityCandidates(
      work.candidates.map((candidate) => ({
        ...(catalogById.get(candidate.appleArtistId)
          ? { catalog: catalogById.get(candidate.appleArtistId)! }
          : {}),
        claimedByOtherCanonicalArtist: candidate.claimedByOtherCanonicalArtist,
        ...(sources.get(candidate.appleArtistId)
          ? { exactIndependentLink: sources.get(candidate.appleArtistId)! }
          : {}),
        proposedAppleArtistId: candidate.appleArtistId,
      })),
      context,
    );
    await persistAppleIdentityCandidateRankings(input.db, work.artistId, rankings, sources);
    rankedArtists += 1;
    eliminatedCandidates += rankings.filter((ranking) => ranking.eliminationSafe).length;
  }

  const calibrationGroups = truthGroups.map((group) => ({
    candidates: rankAppleIdentityCandidates(
      group.candidateIds.map((appleArtistId) => ({
        ...(catalogById.get(appleArtistId) ? { catalog: catalogById.get(appleArtistId)! } : {}),
        claimedByOtherCanonicalArtist:
          Boolean(claimedById.get(appleArtistId)) &&
          claimedById.get(appleArtistId) !== group.artistId,
        proposedAppleArtistId: appleArtistId,
      })),
      context,
    ),
    trueAppleArtistId: group.trueAppleArtistId,
  }));
  const calibration = calibrateAppleIdentityRankings(calibrationGroups);
  const finalWork = await loadAppleIdentityRankingWork(input.db, { artistLimit: 500 });
  return {
    automaticallyResolvedArtists,
    calibration: {
      ...calibration,
      confirmedMappings: confirmedMappings.length + automaticallyResolvedArtists,
      reconstructableTruthGroups: truthGroups.length,
    },
    catalogsFetched,
    catalogsReused,
    collaborationSupportedResolutions: 0,
    directMusicBrainzMatches,
    eliminatedCandidates,
    failures,
    appleFamilyRequests: input.catalogClient.metrics.requests,
    remainingManualArtists: finalWork.length,
    rankedArtists,
    splitProfileConflicts,
    titleOverlapResolutions: 0,
    wikidataMatches,
    wikidataRequests,
  };
}

export function collectDirectAppleLinks(
  relationships: MusicBrainzArtistUrlRelationship[],
): Map<string, "musicbrainz_url"> {
  const ids = new Map<string, "musicbrainz_url">();
  for (const relationship of relationships) {
    try {
      const url = new URL(relationship.url.resource);
      if (!["music.apple.com", "itunes.apple.com"].includes(url.hostname)) continue;
      const match = url.pathname.match(/\/artist(?:\/[^/]+)?\/(\d{1,32})(?:\/|$)/);
      if (match?.[1]) ids.set(match[1], "musicbrainz_url");
    } catch {
      continue;
    }
  }
  return ids;
}

export function collectWikidataIds(relationships: MusicBrainzArtistUrlRelationship[]): string[] {
  const ids = new Set<string>();
  for (const relationship of relationships) {
    const match = relationship.url.resource.match(
      /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q\d+)(?:[?#/]|$)/i,
    );
    if (match?.[1]) ids.add(match[1].toUpperCase());
  }
  return [...ids];
}

const wikidataEntitySchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      claims: z
        .object({
          P2850: z
            .array(
              z.object({
                mainsnak: z.object({
                  datavalue: z.object({ value: z.string().regex(/^\d{1,32}$/) }).optional(),
                }),
              }),
            )
            .default([]),
        })
        .passthrough(),
    }),
  ),
});

export async function fetchWikidataAppleArtistIds(
  entityId: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  if (!/^Q\d+$/.test(entityId)) throw new Error("Wikidata entity ID is invalid.");
  const response = await fetchImpl(
    `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`,
    {
      headers: { Accept: "application/json", "User-Agent": "TSNewMusicRadar/0.1.0" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`Wikidata request failed with HTTP ${response.status}.`);
  const parsed = wikidataEntitySchema.parse(await response.json());
  return [
    ...new Set(
      (parsed.entities[entityId]?.claims.P2850 ?? [])
        .map((claim) => claim.mainsnak.datavalue?.value)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function exactEvidence(
  source: "musicbrainz_url" | "wikidata_property",
  musicBrainzId: string,
): string {
  return source === "musicbrainz_url"
    ? `Confirmed MusicBrainz artist ${musicBrainzId} has a direct Apple artist URL relationship.`
    : `The Wikidata entity directly linked from confirmed MusicBrainz artist ${musicBrainzId} supplies Apple artist property P2850.`;
}

function catalogRequestIdentity(catalog: AppleIdentityCandidateCatalog): string {
  return catalog.source === "itunes_lookup"
    ? `itunes_identity:us:artist:${catalog.appleArtistId}:songs:50:recent`
    : `apple_identity:us:artist:${catalog.appleArtistId}:views:v1`;
}

function rankingContext(
  claimedById: ReadonlyMap<string, string>,
  catalogById: ReadonlyMap<string, AppleIdentityCandidateCatalog>,
) {
  const confirmedAppleArtistIds = new Set(claimedById.keys());
  const confirmedCatalogs = [...confirmedAppleArtistIds]
    .map((id) => catalogById.get(id))
    .filter((catalog): catalog is AppleIdentityCandidateCatalog => Boolean(catalog));
  return {
    confirmedAppleArtistIds,
    genreFrequency: buildAppleIdentityGenreFrequency(confirmedCatalogs),
    now: new Date(),
    truthSetSize: confirmedCatalogs.length,
  };
}

function safeClassification(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown_error";
}
