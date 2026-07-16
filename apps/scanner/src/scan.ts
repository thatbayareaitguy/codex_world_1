import {
  log,
  matchCandidate,
  normalizeIdentifier,
  normalizeText,
  type CanonicalTrack,
  type MatchDecision,
  type TrackCandidate,
} from "@radar/core";
import {
  artistAliases,
  artistExternalIds,
  artistFollows,
  artists,
  createDatabase,
  feedItems,
  providerCursors,
  releaseCandidates,
  releaseExternalIds,
  releases,
  scanLocks,
  scanRuns,
  sourceEvidence,
  trackAvailabilities,
  trackCredits,
  trackExternalIds,
  tracks,
  upcomingAnnouncements,
  upcomingDateHistory,
  users,
  ensureLocalOwner,
  SpotifyTokenManager,
  type RadarDatabase,
} from "@radar/db";
import {
  loadProviderConfiguration,
  MockProvider,
  MusicBrainzClient,
  MusicBrainzProvider,
  SpotifyClient,
  SpotifyOAuthClient,
  SpotifyProvider,
  type CanonicalArtistMappingInput,
  type DiscoveryProvider,
  type SpotifyArtistMapping,
} from "@radar/providers";
import { mockProviderFixture } from "@radar/testing";
import { and, eq, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ScannerOptions } from "./args";

export interface ScanSummary {
  discovered: number;
  inserted: number;
  skipped: number;
  needsReview: number;
  dryRun: boolean;
  providerResults?: Record<string, { error?: string; inserted: number; discovered: number }>;
}

type DatabaseExecutor = Pick<RadarDatabase, "insert" | "query" | "select">;

export async function runScan(options: ScannerOptions): Promise<ScanSummary> {
  const configuration = loadProviderConfiguration();
  const requested = options.provider;
  if (requested && !["mock", "spotify", "musicbrainz"].includes(requested)) {
    throw new Error(`Provider ${requested} is excluded from the current milestone`);
  }

  const selected: Array<"mock" | "spotify" | "musicbrainz"> = requested
    ? [requested as "mock" | "spotify" | "musicbrainz"]
    : [
        ...(configuration.spotify.configured ? (["spotify"] as const) : []),
        ...(configuration.musicbrainz.configured ? (["musicbrainz"] as const) : []),
      ];
  if (selected.length === 0) selected.push("mock");

  if (selected.length === 1 && selected[0] === "mock") {
    const result = await new MockProvider(mockProviderFixture).scan({
      filter: {
        ...(options.full ? { full: true } : {}),
        provider: "mock",
        ...(options.since ? { since: options.since } : {}),
      },
    });
    const summary: ScanSummary = {
      discovered: result.candidates.length,
      inserted: 0,
      skipped: 0,
      needsReview: 0,
      dryRun: options.dryRun,
    };
    if (options.dryRun) {
      log("info", "scan.dry_run_completed", summary);
      return summary;
    }
    const { db, client } = createDatabase();
    try {
      return await persistCandidates(db, result.candidates, options, result.nextCursor);
    } finally {
      await client.end();
    }
  }

  if (!configuration.databaseUrl) {
    throw new Error("DATABASE_URL is required for configured provider scans");
  }
  const { db, client } = createDatabase(configuration.databaseUrl);
  const aggregate: ScanSummary = {
    discovered: 0,
    inserted: 0,
    skipped: 0,
    needsReview: 0,
    dryRun: options.dryRun,
    providerResults: {},
  };
  try {
    const providers = await buildProviders(db, selected, configuration);
    const failures: Error[] = [];
    for (const provider of providers) {
      try {
        if (provider.name === "musicbrainz") {
          await new Promise((resolve) =>
            setTimeout(resolve, 100 + Math.floor(Math.random() * 400)),
          );
        }
        const result = await provider.scan({
          filter: {
            ...(options.artistId ? { artistId: options.artistId } : {}),
            ...(options.full ? { full: true } : {}),
            provider: provider.name,
            since:
              options.since ??
              new Date(Date.now() - configuration.initialBackfillDays * 86_400_000)
                .toISOString()
                .slice(0, 10),
          },
        });
        const summary = options.dryRun
          ? {
              discovered: result.candidates.length,
              dryRun: true,
              inserted: 0,
              needsReview: 0,
              skipped: 0,
            }
          : await persistCandidates(
              db,
              result.candidates,
              { ...options, provider: provider.name },
              result.nextCursor,
              result.providerMetrics,
            );
        aggregate.discovered += summary.discovered;
        aggregate.inserted += summary.inserted;
        aggregate.skipped += summary.skipped;
        aggregate.needsReview += summary.needsReview;
        aggregate.providerResults![provider.name] = {
          discovered: summary.discovered,
          inserted: summary.inserted,
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Unknown provider error");
        failures.push(failure);
        aggregate.providerResults![provider.name] = {
          discovered: 0,
          error: failure.message,
          inserted: 0,
        };
        await recordProviderFailure(db, provider.name, options, failure);
        log("error", "scan.provider_failed", {
          message: failure.message,
          provider: provider.name,
        });
      }
    }
    if (failures.length === providers.length || (requested && failures.length > 0)) {
      throw new Error(failures.map((failure) => failure.message).join("; "));
    }
    log("info", options.dryRun ? "scan.dry_run_completed" : "scan.completed", aggregate);
    return aggregate;
  } finally {
    await client.end();
  }
}

async function buildProviders(
  db: RadarDatabase,
  selected: Array<"mock" | "spotify" | "musicbrainz">,
  configuration: ReturnType<typeof loadProviderConfiguration>,
): Promise<DiscoveryProvider[]> {
  const providers: DiscoveryProvider[] = [];
  for (const provider of selected) {
    if (provider === "mock") {
      providers.push(new MockProvider(mockProviderFixture));
      continue;
    }
    if (provider === "spotify") {
      if (
        !configuration.spotify.configured ||
        !configuration.spotify.clientId ||
        !configuration.spotify.clientSecret ||
        !configuration.appEncryptionKey
      ) {
        throw new Error(
          "Spotify is not configured. Set its client credentials and APP_ENCRYPTION_KEY.",
        );
      }
      const ownerId = await ensureLocalOwner(db);
      const oauthClient = new SpotifyOAuthClient({
        clientId: configuration.spotify.clientId,
        clientSecret: configuration.spotify.clientSecret,
        redirectUri: configuration.spotify.redirectUri,
      });
      const tokenManager = new SpotifyTokenManager(
        db,
        ownerId,
        configuration.appEncryptionKey,
        oauthClient,
      );
      const client = new SpotifyClient({
        accessToken: () => tokenManager.getAccessToken(),
        onUnauthorized: () => tokenManager.refresh().then(() => undefined),
      });
      providers.push(new SpotifyProvider({ client, mappings: await spotifyMappings(db) }));
      continue;
    }
    if (!configuration.musicbrainz.configured || !configuration.musicbrainz.contactEmail) {
      throw new Error("MusicBrainz is not configured. Set MUSICBRAINZ_CONTACT_EMAIL.");
    }
    providers.push(
      new MusicBrainzProvider(
        new MusicBrainzClient({ contactEmail: configuration.musicbrainz.contactEmail }),
        await musicBrainzMappings(db),
      ),
    );
  }
  return providers;
}

async function spotifyMappings(db: RadarDatabase): Promise<SpotifyArtistMapping[]> {
  const mappings = await db
    .select({
      artistId: artistExternalIds.artistId,
      name: artists.name,
      spotifyArtistId: artistExternalIds.externalId,
    })
    .from(artistExternalIds)
    .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
    .where(and(eq(artistExternalIds.provider, "spotify"), eq(artistExternalIds.confirmed, true)));
  return mappings;
}

async function musicBrainzMappings(db: RadarDatabase): Promise<CanonicalArtistMappingInput[]> {
  const mappings = await db
    .select({
      artistId: artistExternalIds.artistId,
      mbid: artistExternalIds.externalId,
      name: artists.name,
    })
    .from(artistExternalIds)
    .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
    .where(
      and(eq(artistExternalIds.provider, "musicbrainz"), eq(artistExternalIds.confirmed, true)),
    );
  const aliases = await db.select().from(artistAliases);
  return mappings.map((mapping) => ({
    ...mapping,
    aliases: aliases
      .filter((alias) => alias.artistId === mapping.artistId)
      .map((alias) => alias.name),
  }));
}

async function recordProviderFailure(
  db: RadarDatabase,
  provider: TrackCandidate["provider"],
  options: ScannerOptions,
  error: Error,
): Promise<void> {
  await db.insert(scanRuns).values({
    provider,
    status: "failed",
    dryRun: options.dryRun,
    ...(options.artistId ? { artistFilter: options.artistId } : {}),
    completedAt: new Date(),
    errors: [{ message: error.message }],
  });
}

export async function persistCandidates(
  db: RadarDatabase,
  candidates: TrackCandidate[],
  options: ScannerOptions,
  nextCursor?: string,
  providerMetrics?: { failures: number; requests: number; waitMs: number },
): Promise<ScanSummary> {
  const provider = candidates[0]?.provider ?? options.provider ?? "mock";
  return withScanLock(db, provider, () =>
    persistCandidatesUnlocked(db, candidates, options, nextCursor, provider, providerMetrics),
  );
}

async function persistCandidatesUnlocked(
  db: RadarDatabase,
  candidates: TrackCandidate[],
  options: ScannerOptions,
  nextCursor: string | undefined,
  provider: TrackCandidate["provider"],
  providerMetrics?: { failures: number; requests: number; waitMs: number },
): Promise<ScanSummary> {
  const [run] = await db
    .insert(scanRuns)
    .values({
      provider,
      dryRun: false,
      metadata: providerMetrics ? { providerMetrics } : {},
      ...(options.artistId ? { artistFilter: options.artistId } : {}),
    })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error("Failed to create scan run");

  const summary: ScanSummary = {
    discovered: candidates.length,
    inserted: 0,
    skipped: 0,
    needsReview: 0,
    dryRun: false,
  };

  try {
    await db.transaction(async (tx) => {
      const userId = await ensureOwner(tx);
      const canonicalTracks = await loadCanonicalTracks(tx);

      for (const candidate of candidates) {
        const existing = await tx.query.releaseCandidates.findFirst({
          where: and(
            eq(releaseCandidates.provider, candidate.provider),
            eq(releaseCandidates.providerReleaseId, candidate.externalReleaseId),
            eq(releaseCandidates.providerTrackId, candidate.externalTrackId),
          ),
          columns: { id: true },
        });
        if (existing) {
          summary.skipped += 1;
          continue;
        }

        const primaryArtistId = await ensureArtist(tx, candidate);
        await tx
          .insert(artistFollows)
          .values({ userId, artistId: primaryArtistId })
          .onConflictDoNothing();

        const providerMatch = await tx.query.trackExternalIds.findFirst({
          where: and(
            eq(trackExternalIds.provider, candidate.provider),
            eq(trackExternalIds.externalId, candidate.externalTrackId),
          ),
          columns: { trackId: true },
        });
        const decision: MatchDecision = providerMatch
          ? {
              canonicalTrackId: providerMatch.trackId,
              confidence: 1,
              kind: "automatic",
              reasons: ["Provider track identifier is identical"],
              rule: "exact_provider_id",
            }
          : matchCandidate(candidate, canonicalTracks);
        const trackId = await resolveTrack(
          tx,
          candidate,
          decision,
          primaryArtistId,
          canonicalTracks,
        );
        if (decision.kind === "review") summary.needsReview += 1;

        let releaseId: string | undefined;
        if (trackId) {
          const trackRow = await tx.query.tracks.findFirst({
            where: eq(tracks.id, trackId),
            columns: { releaseId: true },
          });
          releaseId = trackRow?.releaseId ?? undefined;
        }

        const [candidateRow] = await tx
          .insert(releaseCandidates)
          .values({
            scanRunId: run.id,
            provider: candidate.provider,
            providerReleaseId: candidate.externalReleaseId,
            providerTrackId: candidate.externalTrackId,
            artistExternalId: candidate.artistExternalId,
            title: candidate.title,
            normalizedTitle: normalizeText(candidate.title),
            releaseDate: candidate.releaseDate,
            rawPayload: candidate,
            payloadHash: candidate.payloadHash,
            matchStatus:
              decision.kind === "review"
                ? "needs_review"
                : decision.kind === "new"
                  ? "new"
                  : "matched",
            ...(trackId ? { matchedTrackId: trackId } : {}),
            matchRule: decision.rule,
            matchConfidence: decision.confidence.toFixed(3),
            matchReasons: decision.reasons,
            matchingAlgorithmVersion: "v2-real-providers",
            firstSeenAt: new Date(candidate.firstSeenAt),
          })
          .returning({ id: releaseCandidates.id });
        if (!candidateRow) throw new Error("Failed to insert candidate");

        await tx
          .insert(sourceEvidence)
          .values({
            candidateId: candidateRow.id,
            provider: candidate.provider,
            evidenceType: candidate.evidenceType,
            externalId: candidate.externalTrackId,
            sourceUrl: candidate.evidenceUrl,
            payloadHash: candidate.payloadHash,
            retrievedAt: new Date(candidate.firstSeenAt),
          })
          .onConflictDoNothing();

        if (trackId && decision.kind !== "review") {
          await tx
            .insert(trackAvailabilities)
            .values({
              trackId,
              provider: candidate.provider,
              providerTrackId: candidate.externalTrackId,
              region: candidate.region,
              state: candidate.availability,
              providerUrl: candidate.providerUrl,
            })
            .onConflictDoNothing();
          await tx
            .insert(trackExternalIds)
            .values({
              externalId: candidate.externalTrackId,
              provider: candidate.provider,
              providerFields: {
                availability: candidate.availability,
                region: candidate.region,
                sourceLabel: candidate.sourceLabel,
              },
              providerUrl: candidate.providerUrl,
              trackId,
            })
            .onConflictDoUpdate({
              target: [trackExternalIds.provider, trackExternalIds.externalId],
              set: {
                providerFields: {
                  availability: candidate.availability,
                  region: candidate.region,
                  sourceLabel: candidate.sourceLabel,
                },
                providerUrl: candidate.providerUrl,
                updatedAt: new Date(),
              },
            });
          if (releaseId) {
            await tx
              .insert(releaseExternalIds)
              .values({
                externalId: candidate.externalReleaseId,
                provider: candidate.provider,
                providerFields: {
                  releaseDate: candidate.releaseDate,
                  releaseDatePrecision: candidate.releaseDatePrecision,
                  releaseType: candidate.releaseType,
                  sourceLabel: candidate.sourceLabel,
                },
                providerUrl: providerReleaseUrl(candidate),
                releaseId,
              })
              .onConflictDoUpdate({
                target: [releaseExternalIds.provider, releaseExternalIds.externalId],
                set: {
                  providerFields: {
                    releaseDate: candidate.releaseDate,
                    releaseDatePrecision: candidate.releaseDatePrecision,
                    releaseType: candidate.releaseType,
                    sourceLabel: candidate.sourceLabel,
                  },
                  updatedAt: new Date(),
                },
              });
          }
        }

        if (candidate.isUpcoming && releaseId) {
          const [announcement] = await tx
            .insert(upcomingAnnouncements)
            .values({
              artistId: primaryArtistId,
              confidence: candidate.provider === "musicbrainz" ? "0.700" : "0.850",
              datePrecision: candidate.releaseDatePrecision,
              evidenceUrl: candidate.evidenceUrl,
              externalId: candidate.externalReleaseId,
              firstSeenAt: new Date(candidate.firstSeenAt),
              provider: candidate.provider,
              releaseId,
              scheduledFor: candidate.releaseDate,
              title: candidate.releaseTitle,
            })
            .onConflictDoUpdate({
              target: [upcomingAnnouncements.provider, upcomingAnnouncements.externalId],
              set: {
                datePrecision: candidate.releaseDatePrecision,
                evidenceUrl: candidate.evidenceUrl,
                releaseId,
                scheduledFor: candidate.releaseDate,
              },
            })
            .returning({ id: upcomingAnnouncements.id });
          if (announcement) {
            await tx
              .insert(upcomingDateHistory)
              .values({
                announcementId: announcement.id,
                datePrecision: candidate.releaseDatePrecision,
                scheduledFor: candidate.releaseDate,
              })
              .onConflictDoNothing();
          }
        }

        await tx
          .insert(feedItems)
          .values({
            userId,
            candidateId: candidateRow.id,
            ...(trackId ? { trackId } : {}),
            ...(releaseId ? { releaseId } : {}),
            state: candidate.isUpcoming
              ? "upcoming"
              : decision.kind === "review"
                ? "needs_review"
                : "new",
            dedupeKey: `${candidate.provider}:${candidate.externalReleaseId}:${candidate.externalTrackId}`,
            firstSeenAt: new Date(candidate.firstSeenAt),
          })
          .onConflictDoNothing();
        summary.inserted += 1;
      }

      if (nextCursor) {
        await tx
          .insert(providerCursors)
          .values({
            provider,
            cursorScope: "global",
            scopeId: "default",
            cursorValue: nextCursor,
          })
          .onConflictDoUpdate({
            target: [
              providerCursors.provider,
              providerCursors.cursorScope,
              providerCursors.scopeId,
            ],
            set: { cursorValue: nextCursor, updatedAt: new Date() },
          });
      }
    });

    await db
      .update(scanRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        discoveredCount: summary.discovered,
        insertedCount: summary.inserted,
        skippedCount: summary.skipped,
        reviewCount: summary.needsReview,
        providerResults: {
          [provider]: {
            discovered: summary.discovered,
            inserted: summary.inserted,
            skipped: summary.skipped,
            status: "completed",
          },
        },
      })
      .where(eq(scanRuns.id, run.id));
    return summary;
  } catch (error) {
    await db
      .update(scanRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errors: [{ message: error instanceof Error ? error.message : "Unknown scan error" }],
      })
      .where(eq(scanRuns.id, run.id));
    throw error;
  }
}

async function withScanLock<T>(
  db: RadarDatabase,
  provider: TrackCandidate["provider"],
  operation: () => Promise<T>,
): Promise<T> {
  const ownerToken = randomUUID();
  const now = new Date();
  await db
    .delete(scanLocks)
    .where(and(eq(scanLocks.provider, provider), lt(scanLocks.expiresAt, now)));
  const [lock] = await db
    .insert(scanLocks)
    .values({
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      ownerToken,
      provider,
    })
    .onConflictDoNothing()
    .returning({ provider: scanLocks.provider });
  if (!lock) throw new Error(`A ${provider} scan is already running`);
  try {
    return await operation();
  } finally {
    await db
      .delete(scanLocks)
      .where(and(eq(scanLocks.provider, provider), eq(scanLocks.ownerToken, ownerToken)));
  }
}

function providerReleaseUrl(candidate: TrackCandidate): string {
  if (candidate.provider === "spotify") {
    return `https://open.spotify.com/album/${encodeURIComponent(candidate.externalReleaseId)}`;
  }
  if (candidate.provider === "musicbrainz") {
    return `https://musicbrainz.org/release/${encodeURIComponent(candidate.externalReleaseId)}`;
  }
  return candidate.evidenceUrl;
}

async function ensureOwner(db: DatabaseExecutor): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ email: "owner@local.invalid", displayName: "TS" })
    .onConflictDoUpdate({ target: users.email, set: { displayName: "TS", updatedAt: new Date() } })
    .returning({ id: users.id });
  if (!owner) throw new Error("Failed to ensure local owner");
  return owner.id;
}

async function ensureArtist(db: DatabaseExecutor, candidate: TrackCandidate): Promise<string> {
  const existing = await db.query.artistExternalIds.findFirst({
    where: and(
      eq(artistExternalIds.provider, candidate.provider),
      eq(artistExternalIds.externalId, candidate.artistExternalId),
    ),
    columns: { artistId: true },
  });
  if (existing) return existing.artistId;

  const [artist] = await db
    .insert(artists)
    .values({ name: candidate.artistName, normalizedName: normalizeText(candidate.artistName) })
    .returning({ id: artists.id });
  if (!artist) throw new Error("Failed to create artist");
  await db.insert(artistExternalIds).values({
    artistId: artist.id,
    provider: candidate.provider,
    externalId: candidate.artistExternalId,
    providerUrl: candidate.providerUrl,
    confirmed: true,
  });
  return artist.id;
}

async function loadCanonicalTracks(db: DatabaseExecutor): Promise<CanonicalTrack[]> {
  const trackRows = await db
    .select({ release: releases, track: tracks })
    .from(tracks)
    .leftJoin(releases, eq(releases.id, tracks.releaseId));
  const creditRows = await db.select().from(trackCredits);
  return trackRows.map(({ release, track }) => ({
    id: track.id,
    title: track.title,
    normalizedTitle: track.normalizedTitle,
    credits: creditRows
      .filter((credit) => credit.trackId === track.id)
      .sort((a, b) => a.creditOrder - b.creditOrder)
      .map((credit) => ({ name: credit.creditedName, role: credit.role as "primary" })),
    ...(track.durationMs !== null ? { durationMs: track.durationMs } : {}),
    ...(track.isrc !== null ? { isrc: track.isrc } : {}),
    ...(release?.upc ? { upc: release.upc } : {}),
    ...(release?.ean ? { ean: release.ean } : {}),
    ...(track.discNumber !== null ? { discNumber: track.discNumber } : {}),
    ...(track.trackNumber !== null ? { trackNumber: track.trackNumber } : {}),
    ...(track.musicbrainzRecordingId !== null
      ? { musicbrainzRecordingId: track.musicbrainzRecordingId }
      : {}),
    ...(track.musicbrainzReleaseGroupId !== null
      ? { musicbrainzReleaseGroupId: track.musicbrainzReleaseGroupId }
      : {}),
    ...(track.version !== null ? { version: track.version } : {}),
  }));
}

async function resolveTrack(
  db: DatabaseExecutor,
  candidate: TrackCandidate,
  decision: MatchDecision,
  primaryArtistId: string,
  canonicalTracks: CanonicalTrack[],
): Promise<string | undefined> {
  if (decision.kind === "automatic") return decision.canonicalTrackId;
  if (decision.kind === "review") return decision.canonicalTrackId;

  const providerRelease = await db.query.releaseExternalIds.findFirst({
    where: and(
      eq(releaseExternalIds.provider, candidate.provider),
      eq(releaseExternalIds.externalId, candidate.externalReleaseId),
    ),
    columns: { releaseId: true },
  });
  const normalizedUpc = candidate.upc ? normalizeIdentifier(candidate.upc) : undefined;
  const normalizedEan = candidate.ean ? normalizeIdentifier(candidate.ean) : undefined;
  const barcodeRelease =
    providerRelease || (!normalizedUpc && !normalizedEan)
      ? undefined
      : await db.query.releases.findFirst({
          where: or(
            ...(normalizedUpc ? [eq(releases.upc, normalizedUpc)] : []),
            ...(normalizedEan ? [eq(releases.ean, normalizedEan)] : []),
          ),
          columns: { id: true },
        });
  const existingReleaseId = providerRelease?.releaseId ?? barcodeRelease?.id;
  const [createdRelease] = existingReleaseId
    ? []
    : await db
        .insert(releases)
        .values({
          title: candidate.releaseTitle,
          normalizedTitle: normalizeText(candidate.releaseTitle),
          releaseType: candidate.releaseType,
          releaseDate: candidate.releaseDate,
          releaseDatePrecision: candidate.releaseDatePrecision,
          ...(normalizedUpc ? { upc: normalizedUpc } : {}),
          ...(normalizedEan ? { ean: normalizedEan } : {}),
          ...(candidate.version ? { version: candidate.version } : {}),
        })
        .returning({ id: releases.id });
  const release = existingReleaseId ? { id: existingReleaseId } : createdRelease;
  if (!release) throw new Error("Failed to create release");

  const [track] = await db
    .insert(tracks)
    .values({
      releaseId: release.id,
      title: candidate.title,
      normalizedTitle: normalizeText(candidate.title),
      ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
      ...(candidate.isrc ? { isrc: normalizeIdentifier(candidate.isrc) } : {}),
      ...(candidate.discNumber ? { discNumber: candidate.discNumber } : {}),
      ...(candidate.trackNumber ? { trackNumber: candidate.trackNumber } : {}),
      ...(candidate.musicbrainzRecordingId
        ? { musicbrainzRecordingId: candidate.musicbrainzRecordingId }
        : {}),
      ...(candidate.musicbrainzReleaseGroupId
        ? { musicbrainzReleaseGroupId: candidate.musicbrainzReleaseGroupId }
        : {}),
      ...(candidate.version ? { version: candidate.version } : {}),
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error("Failed to create track");

  const credits = candidate.credits.length
    ? candidate.credits
    : [{ name: candidate.artistName, role: "primary" as const }];
  for (const [creditOrder, credit] of credits.entries()) {
    const artistId =
      creditOrder === 0 ? primaryArtistId : await ensureCreditArtist(db, credit.name);
    await db.insert(trackCredits).values({
      trackId: track.id,
      artistId,
      creditOrder,
      role: credit.role,
      creditedName: credit.name,
    });
  }
  canonicalTracks.push({
    id: track.id,
    title: candidate.title,
    normalizedTitle: normalizeText(candidate.title),
    credits: candidate.credits,
    ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
    ...(candidate.isrc ? { isrc: normalizeIdentifier(candidate.isrc) } : {}),
    ...(candidate.upc ? { upc: candidate.upc } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.discNumber ? { discNumber: candidate.discNumber } : {}),
    ...(candidate.trackNumber ? { trackNumber: candidate.trackNumber } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
  });
  return track.id;
}

async function ensureCreditArtist(db: DatabaseExecutor, name: string): Promise<string> {
  const normalizedName = normalizeText(name);
  const existing = await db.query.artists.findFirst({
    where: eq(artists.normalizedName, normalizedName),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const [artist] = await db
    .insert(artists)
    .values({ name, normalizedName })
    .returning({ id: artists.id });
  if (!artist) throw new Error("Failed to create credited artist");
  return artist.id;
}
