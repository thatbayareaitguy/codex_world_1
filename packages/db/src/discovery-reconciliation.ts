import {
  normalizeText,
  reconcileProviderReleases,
  type ProviderReleaseReconciliationObservation,
} from "@radar/core";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  appleMusicArtistScans,
  appleMusicProviderState,
  appleMusicRequestEvents,
  appleMusicScanBatches,
  artists,
  artistExternalIds,
  artistFollows,
  discoveryReconciliationArtists,
  discoveryReconciliationCampaigns,
  releaseCandidates,
  releaseExternalIds,
  releaseProviderReconciliations,
  releases,
  spotifyArtistScans,
  spotifyProviderState,
  spotifyRequestEvents,
} from "./schema";

export interface DiscoveryReconciliationConfiguration {
  spotifyCohortSize: number;
  spotifyPageLimit: number;
  spotifyRotationSize: number;
  windowDays: number;
}

export interface DiscoveryReconciliationArtistIdentity {
  appleArtistId: string;
  artistId: string;
  name: string;
  spotifyArtistId: string;
}

export async function createOrResumeDiscoveryReconciliationCampaign(
  db: RadarDatabase,
  configuration: DiscoveryReconciliationConfiguration,
  now = new Date(),
  options: { artistLimit?: number } = {},
): Promise<{
  campaignId: string;
  created: boolean;
  identities: DiscoveryReconciliationArtistIdentity[];
}> {
  validateConfiguration(configuration);
  const existing = await db.query.discoveryReconciliationCampaigns.findFirst({
    where: inArray(discoveryReconciliationCampaigns.status, ["planned", "running", "paused"]),
    orderBy: [desc(discoveryReconciliationCampaigns.createdAt)],
  });
  if (existing) {
    return {
      campaignId: existing.id,
      created: false,
      identities: await loadCampaignIdentities(db, existing.id),
    };
  }

  const availableIdentities = await loadDualProviderIdentities(db);
  const identities = options.artistLimit
    ? availableIdentities.slice(0, options.artistLimit)
    : availableIdentities;
  if (identities.length === 0) {
    throw new Error("No active artists have both confirmed Apple Music and Spotify identities.");
  }
  const windowEnd = now.toISOString().slice(0, 10);
  const windowStart = new Date(now.getTime() - configuration.windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const campaignKey = `apple-first:${now.toISOString()}`;
  const [campaign] = await db
    .insert(discoveryReconciliationCampaigns)
    .values({
      campaignKey,
      effectiveConfiguration: configuration,
      spotifyCohortSize: configuration.spotifyCohortSize,
      spotifyPageLimit: configuration.spotifyPageLimit,
      spotifyRotationSize: configuration.spotifyRotationSize,
      status: "running",
      startedAt: now,
      totalArtists: identities.length,
      windowEnd,
      windowStart,
    })
    .returning({ id: discoveryReconciliationCampaigns.id });
  if (!campaign) throw new Error("Failed to create Apple-first reconciliation campaign.");
  await db.insert(discoveryReconciliationArtists).values(
    identities.map((identity, position) => ({
      appleArtistId: identity.appleArtistId,
      artistId: identity.artistId,
      campaignId: campaign.id,
      position,
      spotifyArtistId: identity.spotifyArtistId,
    })),
  );
  return { campaignId: campaign.id, created: true, identities };
}

export async function loadDiscoveryReconciliationCampaign(db: RadarDatabase, campaignId: string) {
  const campaign = await db.query.discoveryReconciliationCampaigns.findFirst({
    where: eq(discoveryReconciliationCampaigns.id, campaignId),
  });
  if (!campaign) throw new Error("Apple-first reconciliation campaign was not found.");
  return campaign;
}

export async function loadCampaignIdentities(
  db: RadarDatabase,
  campaignId: string,
): Promise<DiscoveryReconciliationArtistIdentity[]> {
  return db
    .select({
      appleArtistId: discoveryReconciliationArtists.appleArtistId,
      artistId: discoveryReconciliationArtists.artistId,
      name: artists.name,
      spotifyArtistId: discoveryReconciliationArtists.spotifyArtistId,
    })
    .from(discoveryReconciliationArtists)
    .innerJoin(artists, eq(artists.id, discoveryReconciliationArtists.artistId))
    .where(eq(discoveryReconciliationArtists.campaignId, campaignId))
    .orderBy(asc(discoveryReconciliationArtists.position));
}

export async function recordCampaignAppleBatch(
  db: RadarDatabase,
  campaignId: string,
  batchId: string,
): Promise<void> {
  const campaign = await loadDiscoveryReconciliationCampaign(db, campaignId);
  const [batch, rows, candidates, identities, rateLimits, retries, unfinished] = await Promise.all([
    db.query.appleMusicScanBatches.findFirst({
      where: eq(appleMusicScanBatches.id, batchId),
    }),
    db.select().from(appleMusicArtistScans).where(eq(appleMusicArtistScans.batchId, batchId)),
    db
      .select({
        artistExternalId: releaseCandidates.artistExternalId,
        releaseDate: releaseCandidates.releaseDate,
      })
      .from(releaseCandidates)
      .where(
        and(
          eq(releaseCandidates.provider, "apple_music"),
          gte(releaseCandidates.releaseDate, campaign.windowStart),
        ),
      ),
    loadCampaignIdentities(db, campaignId),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appleMusicRequestEvents)
      .where(
        and(eq(appleMusicRequestEvents.batchId, batchId), eq(appleMusicRequestEvents.status, 429)),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appleMusicRequestEvents)
      .where(
        and(
          eq(appleMusicRequestEvents.batchId, batchId),
          sql`${appleMusicRequestEvents.status} >= 500`,
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appleMusicArtistScans)
      .where(
        and(
          eq(appleMusicArtistScans.batchId, batchId),
          inArray(appleMusicArtistScans.status, ["pending", "running", "retryable"]),
        ),
      ),
  ]);
  if (!batch) throw new Error("Apple Music campaign batch was not found.");
  const identityByAppleId = new Map(
    identities.map((identity) => [identity.appleArtistId, identity]),
  );
  const latestByArtist = new Map<string, string>();
  for (const candidate of candidates) {
    const identity = identityByAppleId.get(candidate.artistExternalId);
    if (!identity) continue;
    const current = latestByArtist.get(identity.artistId);
    if (!current || candidate.releaseDate > current)
      latestByArtist.set(identity.artistId, candidate.releaseDate);
  }
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const latest = latestByArtist.get(row.artistId) ?? null;
      await tx
        .update(discoveryReconciliationArtists)
        .set({
          appleBatchId: batchId,
          appleCandidateCount: row.candidateCount,
          appleRecentDiscovery: latest !== null,
          appleReleaseCount: row.releaseCount,
          appleRequestCount: row.requestCount,
          appleStatus: row.status === "completed" ? "completed" : row.status,
          appleRetryEligibleAt: row.retryEligibleAt,
          latestAppleReleaseDate: latest,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(discoveryReconciliationArtists.campaignId, campaignId),
            eq(discoveryReconciliationArtists.artistId, row.artistId),
          ),
        );
    }
    const totals = await tx
      .select({
        artists: sql<number>`count(*) filter (where ${discoveryReconciliationArtists.appleStatus} in ('completed', 'terminal'))`,
      })
      .from(discoveryReconciliationArtists)
      .where(eq(discoveryReconciliationArtists.campaignId, campaignId));
    const appleRetryCount = Number(retries[0]?.count ?? 0);
    const hasUnfinished = Number(unfinished[0]?.count ?? 0) > 0;
    await tx
      .update(discoveryReconciliationCampaigns)
      .set({
        appleArtistsScanned: Number(totals[0]?.artists ?? 0),
        appleBatchId: batchId,
        appleRateLimitCount: Number(rateLimits[0]?.count ?? 0),
        appleRequestCount: batch.requestCount,
        appleRetryCount,
        errorClassification: null,
        retryCount: sql`${discoveryReconciliationCampaigns.spotifyRetryCount} + ${appleRetryCount}`,
        stage: hasUnfinished ? "apple_discovery" : "spotify_reconciliation",
        status: hasUnfinished ? "paused" : "running",
        updatedAt: new Date(),
      })
      .where(eq(discoveryReconciliationCampaigns.id, campaignId));
  });
}

export async function selectNextSpotifyReconciliationCohort(
  db: RadarDatabase,
  campaignId: string,
): Promise<DiscoveryReconciliationArtistIdentity[]> {
  const campaign = await loadDiscoveryReconciliationCampaign(db, campaignId);
  const now = new Date();
  const [unfilteredMembers, identities, history] = await Promise.all([
    db
      .select()
      .from(discoveryReconciliationArtists)
      .where(
        and(
          eq(discoveryReconciliationArtists.campaignId, campaignId),
          inArray(discoveryReconciliationArtists.spotifyStatus, [
            "pending",
            "selected",
            "rate_limited",
            "failed",
          ]),
        ),
      ),
    loadCampaignIdentities(db, campaignId),
    db
      .select({ artistId: spotifyArtistScans.artistId, finishedAt: spotifyArtistScans.finishedAt })
      .from(spotifyArtistScans)
      .where(inArray(spotifyArtistScans.status, ["completed", "partial"]))
      .orderBy(desc(spotifyArtistScans.finishedAt)),
  ]);
  const members = unfilteredMembers.filter(
    (member) =>
      member.spotifyStatus === "pending" ||
      member.spotifyStatus === "selected" ||
      (member.spotifyStatus === "rate_limited" &&
        (!member.spotifyRetryEligibleAt || member.spotifyRetryEligibleAt <= now)) ||
      (member.spotifyStatus === "failed" && member.attemptCount < 3),
  );
  if (members.length === 0) return [];
  const identityByArtist = new Map(identities.map((identity) => [identity.artistId, identity]));
  const latestSpotifyByArtist = new Map<string, Date>();
  for (const row of history) {
    if (row.finishedAt && !latestSpotifyByArtist.has(row.artistId)) {
      latestSpotifyByArtist.set(row.artistId, row.finishedAt);
    }
  }
  const recent = members
    .filter((member) => member.appleRecentDiscovery)
    .sort(
      (left, right) =>
        (right.latestAppleReleaseDate ?? "").localeCompare(left.latestAppleReleaseDate ?? "") ||
        left.position - right.position,
    );
  const rotating = members
    .filter((member) => !member.appleRecentDiscovery)
    .sort(
      (left, right) =>
        (latestSpotifyByArtist.get(left.artistId)?.getTime() ?? 0) -
          (latestSpotifyByArtist.get(right.artistId)?.getTime() ?? 0) ||
        left.position - right.position,
    );
  const selected = [
    ...recent.slice(0, Math.max(0, campaign.spotifyCohortSize - campaign.spotifyRotationSize)),
    ...rotating.slice(0, campaign.spotifyRotationSize),
  ];
  for (const member of [...recent, ...rotating]) {
    if (selected.length >= campaign.spotifyCohortSize) break;
    if (!selected.some((selectedMember) => selectedMember.artistId === member.artistId)) {
      selected.push(member);
    }
  }
  const selectedIds = selected.map((member) => member.artistId);
  if (selectedIds.length) {
    await db
      .update(discoveryReconciliationArtists)
      .set({
        attemptCount: sql`${discoveryReconciliationArtists.attemptCount} + 1`,
        priorityReason: sql`case when ${discoveryReconciliationArtists.appleRecentDiscovery} then 'recent_apple_discovery' else 'rotating_spotify_fallback' end`,
        spotifyStatus: "selected",
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(discoveryReconciliationArtists.campaignId, campaignId),
          inArray(discoveryReconciliationArtists.artistId, selectedIds),
        ),
      );
  }
  return selected
    .map((member) => identityByArtist.get(member.artistId))
    .filter((identity): identity is DiscoveryReconciliationArtistIdentity => Boolean(identity));
}

export async function recordCampaignSpotifyBatch(
  db: RadarDatabase,
  campaignId: string,
  batchId: string,
): Promise<{ reconciliableArtistIds: string[] }> {
  const rows = await db
    .select()
    .from(spotifyArtistScans)
    .where(eq(spotifyArtistScans.batchId, batchId));
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const status = ["completed", "partial"].includes(row.status)
        ? row.status
        : row.status === "rate_limited"
          ? "rate_limited"
          : ["pending", "running", "paused", "cancelled"].includes(row.status)
            ? "pending"
            : "failed";
      await tx
        .update(discoveryReconciliationArtists)
        .set({
          completedAt: row.finishedAt,
          lastErrorClassification: row.errorClassification,
          spotifyBatchId: batchId,
          spotifyCandidateCount: row.candidateCount,
          spotifyReleaseCount: row.releaseCount ?? 0,
          spotifyRequestCount: sql`case when ${discoveryReconciliationArtists.spotifyBatchId} = ${batchId}::uuid then greatest(${discoveryReconciliationArtists.spotifyRequestCount}, ${row.requestCount}) else ${discoveryReconciliationArtists.spotifyRequestCount} + ${row.requestCount} end`,
          spotifyRetryEligibleAt: row.retryEligibleAt,
          spotifyStatus: status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(discoveryReconciliationArtists.campaignId, campaignId),
            eq(discoveryReconciliationArtists.artistId, row.artistId),
          ),
        );
    }
    const totals = await tx
      .select({
        artists: sql<number>`count(*) filter (where ${discoveryReconciliationArtists.spotifyStatus} in ('completed', 'partial'))`,
        requests: sql<number>`coalesce(sum(${discoveryReconciliationArtists.spotifyRequestCount}), 0)`,
      })
      .from(discoveryReconciliationArtists)
      .where(eq(discoveryReconciliationArtists.campaignId, campaignId));
    const requestTelemetry = await tx
      .select({
        rateLimits: sql<number>`count(*) filter (where ${spotifyRequestEvents.status} = 429)`,
        requests: sql<number>`count(*)`,
        retries: sql<number>`count(*) filter (where ${spotifyRequestEvents.status} >= 500 or (${spotifyRequestEvents.status} is null and ${spotifyRequestEvents.errorClassification} = 'request_failed'))`,
      })
      .from(spotifyRequestEvents)
      .where(eq(spotifyRequestEvents.discoveryReconciliationCampaignId, campaignId));
    const spotifyRetryCount = Number(requestTelemetry[0]?.retries ?? 0);
    await tx
      .update(discoveryReconciliationCampaigns)
      .set({
        retryCount: sql`${discoveryReconciliationCampaigns.appleRetryCount} + ${spotifyRetryCount}`,
        errorClassification: null,
        spotifyArtistsScanned: Number(totals[0]?.artists ?? 0),
        spotifyRateLimitCount: Number(requestTelemetry[0]?.rateLimits ?? 0),
        spotifyRequestCount: Number(requestTelemetry[0]?.requests ?? 0),
        spotifyRetryCount,
        stage: sql`case when ${discoveryReconciliationCampaigns.status} = 'completed_with_spotify_deferred' then ${discoveryReconciliationCampaigns.stage} else 'internal_reconciliation' end`,
        updatedAt: new Date(),
      })
      .where(eq(discoveryReconciliationCampaigns.id, campaignId));
  });
  return {
    reconciliableArtistIds: rows
      .filter((row) => row.status === "completed" || row.status === "partial")
      .map((row) => row.artistId),
  };
}

export async function releaseSelectedSpotifyCohort(
  db: RadarDatabase,
  campaignId: string,
  classification: string,
): Promise<void> {
  await db
    .update(discoveryReconciliationArtists)
    .set({
      lastErrorClassification: classification.slice(0, 100),
      spotifyStatus: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(discoveryReconciliationArtists.campaignId, campaignId),
        eq(discoveryReconciliationArtists.spotifyStatus, "selected"),
      ),
    );
}

export async function reconcileCampaignProviderReleases(
  db: RadarDatabase,
  campaignId: string,
  artistIds?: readonly string[],
): Promise<void> {
  const campaign = await loadDiscoveryReconciliationCampaign(db, campaignId);
  const identities = await loadCampaignIdentities(db, campaignId);
  const selectedIdentities = artistIds
    ? identities.filter((identity) => artistIds.includes(identity.artistId))
    : identities;
  if (selectedIdentities.length === 0) return;
  const observations = await loadReleaseObservations(db, campaign.windowStart, selectedIdentities);
  const byArtist = new Map<string, ProviderReleaseReconciliationObservation[]>();
  for (const item of observations) {
    const list = byArtist.get(item.artistId) ?? [];
    list.push(item.observation);
    byArtist.set(item.artistId, list);
  }
  await db.transaction(async (tx) => {
    for (const identity of selectedIdentities) {
      const results = reconcileProviderReleases(byArtist.get(identity.artistId) ?? []);
      await tx
        .delete(releaseProviderReconciliations)
        .where(
          and(
            eq(releaseProviderReconciliations.campaignId, campaignId),
            eq(releaseProviderReconciliations.artistId, identity.artistId),
          ),
        );
      if (results.length) {
        await tx.insert(releaseProviderReconciliations).values(
          results.map((result) => ({
            appleCanonicalReleaseId: result.appleCanonicalReleaseId,
            appleProviderReleaseId: result.appleProviderReleaseId,
            appleTrackCount: result.appleTrackCount,
            artistId: identity.artistId,
            campaignId,
            confidence: result.confidence.toFixed(3),
            matchedTrackCount: result.matchedTrackCount,
            missingSpotifyTrackCount: result.missingSpotifyTrackCount,
            playlistEligible: result.playlistEligible,
            playlistEligibleTrackCount: result.playlistEligibleTrackCount,
            reasons: result.reasons,
            reconciliationKey: result.reconciliationKey,
            releaseDate: result.releaseDate,
            releaseType: result.releaseType,
            spotifyCanonicalReleaseId: result.spotifyCanonicalReleaseId,
            spotifyProviderReleaseId: result.spotifyProviderReleaseId,
            spotifyTrackCount: result.spotifyTrackCount,
            status: result.status,
            title: result.title,
          })),
        );
      }
    }
    await refreshCampaignReconciliationCounts(tx, campaignId);
  });
}

export async function recordCampaignPlaylistPreview(
  db: RadarDatabase,
  campaignId: string,
  preview: unknown,
): Promise<void> {
  const [appleState, spotifyState, spotifyRequests] = await Promise.all([
    db.query.appleMusicProviderState.findFirst({
      where: eq(appleMusicProviderState.id, "global"),
    }),
    db.query.spotifyProviderState.findFirst({ where: eq(spotifyProviderState.id, "global") }),
    db
      .select({
        rateLimits: sql<number>`count(*) filter (where ${spotifyRequestEvents.status} = 429)`,
        requests: sql<number>`count(*)`,
        retries: sql<number>`count(*) filter (where ${spotifyRequestEvents.status} >= 500 or (${spotifyRequestEvents.status} is null and ${spotifyRequestEvents.errorClassification} = 'request_failed'))`,
      })
      .from(spotifyRequestEvents)
      .where(eq(spotifyRequestEvents.discoveryReconciliationCampaignId, campaignId)),
  ]);
  const spotifyRetryCount = Number(spotifyRequests[0]?.retries ?? 0);
  await db
    .update(discoveryReconciliationCampaigns)
    .set({
      completedAt: new Date(),
      playlistPreview: preview,
      errorClassification: null,
      providerCooldowns: {
        appleMusic: {
          indefinite: appleState?.cooldownIndefinite ?? false,
          until: appleState?.cooldownUntil?.toISOString() ?? null,
        },
        spotify: {
          indefinite: spotifyState?.cooldownIndefinite ?? false,
          until: spotifyState?.cooldownUntil?.toISOString() ?? null,
        },
      },
      stage: "completed",
      status: "completed",
      spotifyRateLimitCount: Number(spotifyRequests[0]?.rateLimits ?? 0),
      spotifyRequestCount: Number(spotifyRequests[0]?.requests ?? 0),
      spotifyRetryCount,
      retryCount: sql`${discoveryReconciliationCampaigns.appleRetryCount} + ${spotifyRetryCount}`,
      updatedAt: new Date(),
    })
    .where(eq(discoveryReconciliationCampaigns.id, campaignId));
}

export async function finishDiscoveryReconciliationCampaign(
  db: RadarDatabase,
  campaignId: string,
): Promise<void> {
  const remaining = await db
    .select({ count: sql<number>`count(*)` })
    .from(discoveryReconciliationArtists)
    .where(
      and(
        eq(discoveryReconciliationArtists.campaignId, campaignId),
        or(
          inArray(discoveryReconciliationArtists.spotifyStatus, [
            "pending",
            "selected",
            "rate_limited",
          ]),
          and(
            eq(discoveryReconciliationArtists.spotifyStatus, "failed"),
            lt(discoveryReconciliationArtists.attemptCount, 3),
          ),
        ),
      ),
    );
  await db
    .update(discoveryReconciliationCampaigns)
    .set({
      completedAt: null,
      errorClassification: null,
      stage: Number(remaining[0]?.count ?? 0) === 0 ? "playlist_preview" : "spotify_reconciliation",
      status: Number(remaining[0]?.count ?? 0) === 0 ? "running" : "paused",
      updatedAt: new Date(),
    })
    .where(eq(discoveryReconciliationCampaigns.id, campaignId));
}

export async function failDiscoveryReconciliationCampaign(
  db: RadarDatabase,
  campaignId: string,
  classification: string,
): Promise<void> {
  await db
    .update(discoveryReconciliationCampaigns)
    .set({
      errorClassification: classification.slice(0, 100),
      status: "paused",
      updatedAt: new Date(),
    })
    .where(eq(discoveryReconciliationCampaigns.id, campaignId));
}

export async function discoveryReconciliationCampaignReport(db: RadarDatabase, campaignId: string) {
  const campaign = await loadDiscoveryReconciliationCampaign(db, campaignId);
  const artistsByStatus = await db
    .select({
      appleStatus: discoveryReconciliationArtists.appleStatus,
      count: sql<number>`count(*)`,
      spotifyStatus: discoveryReconciliationArtists.spotifyStatus,
    })
    .from(discoveryReconciliationArtists)
    .where(eq(discoveryReconciliationArtists.campaignId, campaignId))
    .groupBy(
      discoveryReconciliationArtists.appleStatus,
      discoveryReconciliationArtists.spotifyStatus,
    );
  return { campaign, artistsByStatus };
}

async function loadDualProviderIdentities(
  db: RadarDatabase,
): Promise<DiscoveryReconciliationArtistIdentity[]> {
  const [followed, externalIds] = await Promise.all([
    db
      .select({ artistId: artists.id, name: artists.name, normalizedName: artists.normalizedName })
      .from(artists)
      .innerJoin(artistFollows, eq(artistFollows.artistId, artists.id))
      .where(eq(artistFollows.active, true))
      .orderBy(asc(artists.normalizedName), asc(artists.id)),
    db
      .select({
        artistId: artistExternalIds.artistId,
        externalId: artistExternalIds.externalId,
        provider: artistExternalIds.provider,
      })
      .from(artistExternalIds)
      .where(
        and(
          eq(artistExternalIds.confirmed, true),
          inArray(artistExternalIds.provider, ["apple_music", "spotify"]),
        ),
      ),
  ]);
  const idsByArtist = new Map<string, { appleArtistId?: string; spotifyArtistId?: string }>();
  for (const row of externalIds) {
    const current = idsByArtist.get(row.artistId) ?? {};
    if (row.provider === "apple_music") current.appleArtistId = row.externalId;
    if (row.provider === "spotify") current.spotifyArtistId = row.externalId;
    idsByArtist.set(row.artistId, current);
  }
  return followed.flatMap((artist) => {
    const ids = idsByArtist.get(artist.artistId);
    return ids?.appleArtistId && ids.spotifyArtistId
      ? [
          {
            appleArtistId: ids.appleArtistId,
            artistId: artist.artistId,
            name: artist.name,
            spotifyArtistId: ids.spotifyArtistId,
          },
        ]
      : [];
  });
}

async function loadReleaseObservations(
  db: RadarDatabase,
  windowStart: string,
  identities: readonly DiscoveryReconciliationArtistIdentity[],
): Promise<Array<{ artistId: string; observation: ProviderReleaseReconciliationObservation }>> {
  const artistByProviderIdentity = new Map<string, string>();
  for (const identity of identities) {
    artistByProviderIdentity.set(`apple_music:${identity.appleArtistId}`, identity.artistId);
    artistByProviderIdentity.set(`spotify:${identity.spotifyArtistId}`, identity.artistId);
  }
  const rows = await db
    .select({
      artistExternalId: releaseCandidates.artistExternalId,
      matchConfidence: releaseCandidates.matchConfidence,
      matchedTrackId: releaseCandidates.matchedTrackId,
      matchRule: releaseCandidates.matchRule,
      provider: releaseCandidates.provider,
      providerReleaseId: releaseCandidates.providerReleaseId,
      providerTrackId: releaseCandidates.providerTrackId,
      rawPayload: releaseCandidates.rawPayload,
      releaseDate: releaseCandidates.releaseDate,
    })
    .from(releaseCandidates)
    .where(
      and(
        inArray(releaseCandidates.provider, ["apple_music", "spotify"]),
        gte(releaseCandidates.releaseDate, windowStart),
      ),
    );
  const providerReleaseIds = [...new Set(rows.map((row) => row.providerReleaseId))];
  const externalRows = providerReleaseIds.length
    ? await db
        .select({
          externalId: releaseExternalIds.externalId,
          provider: releaseExternalIds.provider,
          releaseId: releaseExternalIds.releaseId,
        })
        .from(releaseExternalIds)
        .where(
          and(
            inArray(releaseExternalIds.provider, ["apple_music", "spotify"]),
            inArray(releaseExternalIds.externalId, providerReleaseIds),
          ),
        )
    : [];
  const releaseIds = [...new Set(externalRows.map((row) => row.releaseId))];
  const canonicalReleases = releaseIds.length
    ? await db
        .select({
          id: releases.id,
          releaseDate: releases.releaseDate,
          releaseType: releases.releaseType,
          title: releases.title,
        })
        .from(releases)
        .where(inArray(releases.id, releaseIds))
    : [];
  const externalByProvider = new Map(
    externalRows.map((row) => [`${row.provider}:${row.externalId}`, row] as const),
  );
  const canonicalById = new Map(canonicalReleases.map((release) => [release.id, release] as const));
  const grouped = new Map<
    string,
    { artistId: string; observation: ProviderReleaseReconciliationObservation }
  >();
  for (const row of rows) {
    if (row.provider !== "apple_music" && row.provider !== "spotify") continue;
    const artistId = artistByProviderIdentity.get(`${row.provider}:${row.artistExternalId}`);
    if (!artistId) continue;
    const external = externalByProvider.get(`${row.provider}:${row.providerReleaseId}`);
    const canonical = external ? canonicalById.get(external.releaseId) : undefined;
    const raw = candidatePayload(row.rawPayload);
    const key = `${artistId}:${row.provider}:${row.providerReleaseId}`;
    const entry = grouped.get(key) ?? {
      artistId,
      observation: {
        canonicalReleaseId: external?.releaseId ?? null,
        provider: row.provider,
        providerReleaseId: row.providerReleaseId,
        releaseDate: canonical?.releaseDate ?? row.releaseDate,
        releaseType: canonical?.releaseType ?? raw.releaseType ?? "unknown",
        title: canonical?.title ?? raw.releaseTitle ?? row.providerReleaseId,
        tracks: [],
      },
    };
    entry.observation.tracks.push({
      canonicalTrackId: row.matchedTrackId,
      discNumber: raw.discNumber ?? 1,
      normalizedTitle: normalizeText(raw.title ?? row.providerTrackId),
      playlistEligible:
        row.provider === "spotify" &&
        Number(row.matchConfidence) >= 0.98 &&
        (row.matchRule === "new_canonical" || row.matchRule.startsWith("exact_")),
      providerTrackId: row.providerTrackId,
      trackNumber: raw.trackNumber ?? 1,
    });
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

async function refreshCampaignReconciliationCounts(
  db: Pick<RadarDatabase, "select" | "update">,
  campaignId: string,
): Promise<void> {
  const counts = await db
    .select({
      appleOnly: sql<number>`count(*) filter (where ${releaseProviderReconciliations.status} = 'apple_only')`,
      matched: sql<number>`count(*) filter (where ${releaseProviderReconciliations.status} = 'matched')`,
      missingSpotify: sql<number>`coalesce(sum(${releaseProviderReconciliations.missingSpotifyTrackCount}), 0)`,
      playlistEligible: sql<number>`coalesce(sum(${releaseProviderReconciliations.playlistEligibleTrackCount}), 0)`,
      spotifyOnly: sql<number>`count(*) filter (where ${releaseProviderReconciliations.status} = 'spotify_only')`,
      uncertain: sql<number>`count(*) filter (where ${releaseProviderReconciliations.status} = 'uncertain')`,
    })
    .from(releaseProviderReconciliations)
    .where(eq(releaseProviderReconciliations.campaignId, campaignId));
  await db
    .update(discoveryReconciliationCampaigns)
    .set({
      appleOnlyReleaseCount: Number(counts[0]?.appleOnly ?? 0),
      matchedReleaseCount: Number(counts[0]?.matched ?? 0),
      missingSpotifyTrackCount: Number(counts[0]?.missingSpotify ?? 0),
      playlistEligibleTrackCount: Number(counts[0]?.playlistEligible ?? 0),
      spotifyOnlyReleaseCount: Number(counts[0]?.spotifyOnly ?? 0),
      uncertainReleaseCount: Number(counts[0]?.uncertain ?? 0),
      updatedAt: new Date(),
    })
    .where(eq(discoveryReconciliationCampaigns.id, campaignId));
}

function candidatePayload(value: unknown): {
  discNumber?: number;
  releaseTitle?: string;
  releaseType?: string;
  title?: string;
  trackNumber?: number;
} {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.discNumber === "number" ? { discNumber: value.discNumber } : {}),
    ...(typeof value.releaseTitle === "string" ? { releaseTitle: value.releaseTitle } : {}),
    ...(typeof value.releaseType === "string" ? { releaseType: value.releaseType } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.trackNumber === "number" ? { trackNumber: value.trackNumber } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfiguration(configuration: DiscoveryReconciliationConfiguration): void {
  if (!Number.isInteger(configuration.spotifyCohortSize) || configuration.spotifyCohortSize < 1) {
    throw new Error("Spotify reconciliation cohort size must be a positive integer.");
  }
  if (
    !Number.isInteger(configuration.spotifyRotationSize) ||
    configuration.spotifyRotationSize < 0 ||
    configuration.spotifyRotationSize > configuration.spotifyCohortSize
  ) {
    throw new Error("Spotify reconciliation rotation size is invalid.");
  }
  if (!Number.isInteger(configuration.spotifyPageLimit) || configuration.spotifyPageLimit < 1) {
    throw new Error("Spotify reconciliation page limit must be a positive integer.");
  }
  if (!Number.isInteger(configuration.windowDays) || configuration.windowDays < 1) {
    throw new Error("Reconciliation window days must be a positive integer.");
  }
}
