import { normalizeIdentifier, normalizeText } from "@radar/core";
import { trackCandidateSchema } from "@radar/providers";
import { and, asc, eq, ne } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { queueSpotifyTrackResolutionWork } from "./spotify-scheduler";
import {
  artistExternalIds,
  artists,
  discoveryScheduleState,
  feedItems,
  manualMatchDecisions,
  releaseCandidates,
  releaseExternalIds,
  releases,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  trackAvailabilities,
  trackCredits,
  trackExternalIds,
  tracks,
} from "./schema";

export type FeedReviewDecision =
  "confirm" | "confirm_track" | "defer" | "no_equivalent" | "retry" | "separate";

export interface FeedReviewResolution {
  decision: FeedReviewDecision;
  feedItemId: string;
  removed: boolean;
  state: "needs_review" | "new";
  deferredUntil?: Date;
}

export interface FeedReviewGroupResolution extends FeedReviewResolution {
  affectedFeedItemIds: string[];
}

type ReviewCandidate = ReturnType<(typeof trackCandidateSchema)["parse"]>;

export async function resolveFeedReview(
  db: RadarDatabase,
  userId: string,
  feedItemId: string,
  decision: FeedReviewDecision,
  options: { spotifyTrackId?: string } = {},
  now = new Date(),
): Promise<FeedReviewResolution | undefined> {
  return db.transaction((tx) =>
    resolveFeedReviewInTransaction(tx, userId, feedItemId, decision, options, now),
  );
}

export async function resolveFeedReviewGroup(
  db: RadarDatabase,
  userId: string,
  feedItemId: string,
  decision: FeedReviewDecision,
  options: { spotifyTrackId?: string } = {},
  now = new Date(),
): Promise<FeedReviewGroupResolution | undefined> {
  return db.transaction(async (tx) => {
    const group = await loadReviewGroup(tx, userId, feedItemId);
    if (!group) return undefined;
    if (decision === "separate" && group.feedItemIds.length > 1) {
      throw new Error("Choose a specific provider candidate to keep separate");
    }
    if (decision === "no_equivalent" && group.providers.includes("spotify")) {
      throw new Error("A review group with Spotify evidence cannot have no Spotify equivalent");
    }

    const resolutions: FeedReviewResolution[] = [];
    for (const groupedFeedItemId of group.feedItemIds) {
      const resolution = await resolveFeedReviewInTransaction(
        tx,
        userId,
        groupedFeedItemId,
        decision,
        options,
        now,
      );
      if (!resolution) {
        throw new Error("A grouped review candidate could not be resolved");
      }
      resolutions.push(resolution);
    }
    const anchor = resolutions.find((resolution) => resolution.feedItemId === feedItemId);
    if (!anchor) throw new Error("The grouped review anchor could not be resolved");
    return { ...anchor, affectedFeedItemIds: group.feedItemIds };
  });
}

type ReviewTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];

async function loadReviewGroup(
  tx: ReviewTransaction,
  userId: string,
  feedItemId: string,
): Promise<{ feedItemIds: string[]; providers: string[] } | undefined> {
  const anchor = await tx.query.feedItems.findFirst({
    where: and(eq(feedItems.id, feedItemId), eq(feedItems.userId, userId)),
  });
  if (!anchor?.candidateId) return undefined;
  const anchorCandidate = await tx.query.releaseCandidates.findFirst({
    where: eq(releaseCandidates.id, anchor.candidateId),
  });
  if (!anchorCandidate) return undefined;
  if (
    anchor.state !== "needs_review" ||
    anchorCandidate.matchStatus !== "needs_review" ||
    !anchor.releaseId ||
    !anchorCandidate.matchedTrackId
  ) {
    return { feedItemIds: [feedItemId], providers: [anchorCandidate.provider] };
  }

  const rows = await tx
    .select({ feedItemId: feedItems.id, provider: releaseCandidates.provider })
    .from(feedItems)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, feedItems.candidateId))
    .where(
      and(
        eq(feedItems.userId, userId),
        eq(feedItems.state, "needs_review"),
        eq(feedItems.releaseId, anchor.releaseId),
        eq(releaseCandidates.matchStatus, "needs_review"),
        eq(releaseCandidates.matchedTrackId, anchorCandidate.matchedTrackId),
      ),
    );
  const orderedRows = [
    ...rows.filter((row) => row.feedItemId === feedItemId),
    ...rows.filter((row) => row.feedItemId !== feedItemId),
  ];
  return {
    feedItemIds: orderedRows.map((row) => row.feedItemId),
    providers: [...new Set(orderedRows.map((row) => row.provider))],
  };
}

async function resolveFeedReviewInTransaction(
  tx: ReviewTransaction,
  userId: string,
  feedItemId: string,
  decision: FeedReviewDecision,
  options: { spotifyTrackId?: string },
  now: Date,
): Promise<FeedReviewResolution | undefined> {
  const feed = await tx.query.feedItems.findFirst({
    where: and(eq(feedItems.id, feedItemId), eq(feedItems.userId, userId)),
  });
  if (!feed?.candidateId) return undefined;

  const candidate = await tx.query.releaseCandidates.findFirst({
    where: eq(releaseCandidates.id, feed.candidateId),
  });
  if (!candidate) return undefined;
  const existingDecision = await tx.query.manualMatchDecisions.findFirst({
    where: eq(manualMatchDecisions.candidateId, candidate.id),
  });
  if (candidate.matchStatus !== "needs_review" && decision !== "retry") {
    return existingDecision?.decision === decision && feed.state !== "needs_review"
      ? { decision, feedItemId, removed: false, state: "new" }
      : undefined;
  }

  const payload = trackCandidateSchema.parse(candidate.rawPayload);

  if (decision === "defer") {
    const deferredUntil = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    await upsertDecision(
      tx,
      candidate.id,
      userId,
      decision,
      candidate.matchedTrackId,
      "Deferred for seven days",
      now,
      deferredUntil,
    );
    return {
      decision,
      deferredUntil,
      feedItemId,
      removed: false,
      state: "needs_review",
    };
  }

  if (decision === "no_equivalent") {
    if (payload.provider === "spotify") {
      throw new Error("A Spotify candidate cannot be marked as having no Spotify equivalent");
    }
    await upsertDecision(
      tx,
      candidate.id,
      userId,
      decision,
      candidate.matchedTrackId,
      "Manually confirmed that no Spotify equivalent exists",
      now,
    );
    await tx
      .update(releaseCandidates)
      .set({
        matchConfidence: "1.000",
        matchReasons: ["Manually confirmed that no Spotify equivalent exists"],
        matchRule: "manual_no_spotify_equivalent",
        matchStatus: "rejected",
      })
      .where(eq(releaseCandidates.id, candidate.id));
    await tx
      .update(feedItems)
      .set({ state: "new", updatedAt: now })
      .where(eq(feedItems.id, feedItemId));
    return { decision, feedItemId, removed: false, state: "new" };
  }

  if (decision === "retry" || decision === "confirm_track") {
    if (!candidate.matchedTrackId) {
      throw new Error("Review candidate has no canonical track to resolve");
    }
    await queueReviewTrackResolution(
      tx,
      candidate.matchedTrackId,
      decision === "confirm_track" ? options.spotifyTrackId : undefined,
      now,
    );
    await upsertDecision(
      tx,
      candidate.id,
      userId,
      decision,
      candidate.matchedTrackId,
      decision === "confirm_track"
        ? "User selected a specific Spotify track for guarded verification"
        : "User requested a fresh Spotify resolution attempt",
      now,
    );
    await tx
      .update(releaseCandidates)
      .set({ matchStatus: "new" })
      .where(eq(releaseCandidates.id, candidate.id));
    await tx
      .update(feedItems)
      .set({ state: "new", updatedAt: now })
      .where(eq(feedItems.id, feedItemId));
    return { decision, feedItemId, removed: false, state: "new" };
  }

  const releaseId = await ensureReviewRelease(tx, payload, feed.releaseId);

  if (decision === "confirm") {
    if (!candidate.matchedTrackId) {
      throw new Error("Review candidate has no proposed canonical track");
    }
    const appearanceId = await ensureReviewAppearance(
      tx,
      payload,
      candidate.id,
      releaseId,
      candidate.matchedTrackId,
      now,
    );
    await upsertDecision(
      tx,
      candidate.id,
      userId,
      "confirm",
      candidate.matchedTrackId,
      "Manually confirmed match",
      now,
    );
    await tx
      .update(releaseCandidates)
      .set({
        matchConfidence: "1.000",
        matchReasons: ["Manually confirmed match"],
        matchRule: "manual_confirmation",
        matchStatus: "matched",
      })
      .where(eq(releaseCandidates.id, candidate.id));
    await upsertProviderTrack(tx, payload, candidate.matchedTrackId, now);
    const spotifyTrack =
      payload.provider === "spotify"
        ? true
        : Boolean(
            await tx.query.trackExternalIds.findFirst({
              columns: { id: true },
              where: and(
                eq(trackExternalIds.trackId, candidate.matchedTrackId),
                eq(trackExternalIds.provider, "spotify"),
              ),
            }),
          );
    if (spotifyTrack) {
      await queueGuardedPlaylistCheckpoint(tx, now);
    }

    const existingCanonicalFeed = await tx.query.feedItems.findFirst({
      columns: { id: true },
      where: and(
        eq(feedItems.userId, userId),
        eq(feedItems.appearanceId, appearanceId),
        ne(feedItems.id, feedItemId),
        ne(feedItems.state, "needs_review"),
      ),
    });
    if (existingCanonicalFeed) {
      await tx.delete(feedItems).where(eq(feedItems.id, feedItemId));
      await tx
        .update(feedItems)
        .set({ updatedAt: now })
        .where(eq(feedItems.id, existingCanonicalFeed.id));
      return { decision, feedItemId, removed: true, state: "new" };
    }
    await tx
      .update(feedItems)
      .set({ appearanceId, releaseId, state: "new", updatedAt: now })
      .where(eq(feedItems.id, feedItemId));
    return { decision, feedItemId, removed: false, state: "new" };
  }

  const trackId = await createSeparateTrack(tx, payload, releaseId);
  const appearanceId = await ensureReviewAppearance(
    tx,
    payload,
    candidate.id,
    releaseId,
    trackId,
    now,
  );
  await upsertProviderTrack(tx, payload, trackId, now);
  await upsertDecision(
    tx,
    candidate.id,
    userId,
    "separate",
    trackId,
    "Manually preserved as a separate recording",
    now,
  );
  await tx
    .update(releaseCandidates)
    .set({
      matchedTrackId: trackId,
      matchConfidence: "1.000",
      matchReasons: ["Manually preserved as a separate recording"],
      matchRule: "manual_separate",
      matchStatus: "new",
    })
    .where(eq(releaseCandidates.id, candidate.id));
  await tx
    .update(feedItems)
    .set({ appearanceId, releaseId, state: "new", trackId, updatedAt: now })
    .where(eq(feedItems.id, feedItemId));
  return { decision, feedItemId, removed: false, state: "new" };
}

async function queueGuardedPlaylistCheckpoint(tx: ReviewTransaction, now: Date): Promise<void> {
  await tx
    .update(discoveryScheduleState)
    .set({ playlistInboxStatus: "pending", updatedAt: now })
    .where(
      and(
        eq(discoveryScheduleState.id, "global"),
        eq(discoveryScheduleState.phase, "broad_spotify"),
        eq(discoveryScheduleState.playlistInboxStatus, "completed"),
      ),
    );
}

async function ensureReviewRelease(
  tx: ReviewTransaction,
  payload: ReviewCandidate,
  existingReleaseId: string | null,
): Promise<string> {
  if (existingReleaseId) return existingReleaseId;
  const mapped = await tx.query.releaseExternalIds.findFirst({
    where: and(
      eq(releaseExternalIds.provider, payload.provider),
      eq(releaseExternalIds.externalId, payload.externalReleaseId),
    ),
    columns: { releaseId: true },
  });
  if (mapped) return mapped.releaseId;
  const [release] = await tx
    .insert(releases)
    .values({
      releaseDate: payload.releaseDate,
      releaseDatePrecision: payload.releaseDatePrecision,
      releaseType: payload.releaseType,
      title: payload.releaseTitle,
      normalizedTitle: normalizeText(payload.releaseTitle),
      ...(payload.upc ? { upc: normalizeIdentifier(payload.upc) } : {}),
      ...(payload.ean ? { ean: normalizeIdentifier(payload.ean) } : {}),
    })
    .returning({ id: releases.id });
  if (!release) throw new Error("Review release could not be created");
  await tx.insert(releaseExternalIds).values({
    externalId: payload.externalReleaseId,
    provider: payload.provider,
    providerFields: { sourceLabel: payload.sourceLabel },
    providerUrl: reviewReleaseUrl(payload),
    releaseId: release.id,
  });
  return release.id;
}

async function createSeparateTrack(
  tx: ReviewTransaction,
  payload: ReviewCandidate,
  releaseId: string,
): Promise<string> {
  const identity = await availableSeparateIdentity(tx, payload);
  const [track] = await tx
    .insert(tracks)
    .values({
      releaseId,
      title: payload.title,
      normalizedTitle: normalizeText(payload.title),
      ...(payload.durationMs ? { durationMs: payload.durationMs } : {}),
      ...identity,
      ...(payload.discNumber ? { discNumber: payload.discNumber } : {}),
      ...(payload.trackNumber ? { trackNumber: payload.trackNumber } : {}),
      ...(payload.musicbrainzReleaseGroupId
        ? { musicbrainzReleaseGroupId: payload.musicbrainzReleaseGroupId }
        : {}),
      ...(payload.version ? { version: payload.version } : {}),
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error("Separate canonical track could not be created");
  for (const [creditOrder, credit] of payload.credits.entries()) {
    const normalizedName = normalizeText(credit.name);
    const existing = await tx.query.artists.findFirst({
      where: eq(artists.normalizedName, normalizedName),
      columns: { id: true },
    });
    const [created] = existing
      ? []
      : await tx
          .insert(artists)
          .values({ name: credit.name, normalizedName })
          .returning({ id: artists.id });
    const artistId = existing?.id ?? created?.id;
    if (!artistId) throw new Error("Separate track credit artist could not be resolved");
    await tx.insert(trackCredits).values({
      artistId,
      creditedName: credit.name,
      creditOrder,
      role: credit.role,
      trackId: track.id,
    });
  }
  return track.id;
}

async function ensureReviewAppearance(
  tx: ReviewTransaction,
  payload: ReviewCandidate,
  candidateId: string,
  releaseId: string,
  trackId: string,
  now: Date,
): Promise<string> {
  const discNumber = payload.discNumber ?? 1;
  const trackNumber = payload.trackNumber ?? 1;
  const [appearance] = await tx
    .insert(releaseTrackAppearances)
    .values({
      discNumber,
      firstObservedAt: new Date(payload.firstSeenAt),
      lastObservedAt: now,
      presentationMetadata: payload.version ? { version: payload.version } : {},
      providerOrder: payload.trackNumber,
      releaseId,
      trackId,
      trackNumber,
    })
    .onConflictDoUpdate({
      target: [
        releaseTrackAppearances.releaseId,
        releaseTrackAppearances.trackId,
        releaseTrackAppearances.discNumber,
        releaseTrackAppearances.trackNumber,
      ],
      set: { lastObservedAt: now, updatedAt: now },
    })
    .returning({ id: releaseTrackAppearances.id });
  if (!appearance) throw new Error("Review appearance could not be created");
  await tx
    .insert(releaseTrackAppearanceSources)
    .values({
      appearanceId: appearance.id,
      candidateId,
      firstObservedAt: new Date(payload.firstSeenAt),
      lastObservedAt: now,
      observedCredit: payload.credits,
      provider: payload.provider,
      providerReleaseId: payload.externalReleaseId,
      providerTrackId: payload.externalTrackId,
    })
    .onConflictDoUpdate({
      target: releaseTrackAppearanceSources.candidateId,
      set: { appearanceId: appearance.id, lastObservedAt: now, updatedAt: now },
    });
  return appearance.id;
}

async function upsertProviderTrack(
  tx: ReviewTransaction,
  payload: ReviewCandidate,
  trackId: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(trackExternalIds)
    .values({
      externalId: payload.externalTrackId,
      provider: payload.provider,
      providerFields: { availability: payload.availability },
      providerUrl: payload.providerUrl,
      trackId,
    })
    .onConflictDoUpdate({
      target: [trackExternalIds.provider, trackExternalIds.externalId],
      set: { trackId, updatedAt: now },
    });
  await tx
    .insert(trackAvailabilities)
    .values({
      checkedAt: now,
      provider: payload.provider,
      providerTrackId: payload.externalTrackId,
      providerUrl: payload.providerUrl,
      region: payload.region,
      state: payload.availability,
      trackId,
    })
    .onConflictDoUpdate({
      target: [
        trackAvailabilities.provider,
        trackAvailabilities.providerTrackId,
        trackAvailabilities.region,
      ],
      set: {
        checkedAt: now,
        providerUrl: payload.providerUrl,
        state: payload.availability,
        trackId,
      },
    });
}

async function availableSeparateIdentity(
  tx: ReviewTransaction,
  payload: ReviewCandidate,
): Promise<{ isrc?: string; musicbrainzRecordingId?: string }> {
  const normalizedIsrc = payload.isrc ? normalizeIdentifier(payload.isrc) : undefined;
  const existingIsrc = normalizedIsrc
    ? await tx.query.tracks.findFirst({
        columns: { id: true },
        where: eq(tracks.isrc, normalizedIsrc),
      })
    : undefined;
  const existingRecording = payload.musicbrainzRecordingId
    ? await tx.query.tracks.findFirst({
        columns: { id: true },
        where: eq(tracks.musicbrainzRecordingId, payload.musicbrainzRecordingId),
      })
    : undefined;
  return {
    ...(normalizedIsrc && !existingIsrc ? { isrc: normalizedIsrc } : {}),
    ...(payload.musicbrainzRecordingId && !existingRecording
      ? { musicbrainzRecordingId: payload.musicbrainzRecordingId }
      : {}),
  };
}

function reviewReleaseUrl(payload: ReviewCandidate): string {
  if (payload.provider === "spotify") {
    return `https://open.spotify.com/album/${encodeURIComponent(payload.externalReleaseId)}`;
  }
  if (payload.provider === "musicbrainz") {
    return `https://musicbrainz.org/release/${encodeURIComponent(payload.externalReleaseId)}`;
  }
  return payload.evidenceUrl;
}

async function upsertDecision(
  tx: ReviewTransaction,
  candidateId: string,
  userId: string,
  decision: FeedReviewDecision,
  selectedTrackId: string | null,
  reason: string,
  decidedAt: Date,
  deferredUntil: Date | null = null,
) {
  await tx
    .insert(manualMatchDecisions)
    .values({ candidateId, decidedAt, decision, deferredUntil, reason, selectedTrackId, userId })
    .onConflictDoUpdate({
      target: manualMatchDecisions.candidateId,
      set: { decidedAt, decision, deferredUntil, reason, selectedTrackId, userId },
    });
}

async function queueReviewTrackResolution(
  tx: ReviewTransaction,
  trackId: string,
  spotifyTrackId: string | undefined,
  now: Date,
): Promise<void> {
  const track = await tx.query.tracks.findFirst({ where: eq(tracks.id, trackId) });
  if (!track?.isrc) throw new Error("Spotify retry requires a canonical ISRC");
  const credit = await tx.query.trackCredits.findFirst({
    orderBy: [asc(trackCredits.creditOrder)],
    where: eq(trackCredits.trackId, trackId),
  });
  if (!credit) throw new Error("Spotify retry requires a canonical artist credit");
  const spotifyArtist = await tx.query.artistExternalIds.findFirst({
    where: and(
      eq(artistExternalIds.artistId, credit.artistId),
      eq(artistExternalIds.provider, "spotify"),
      eq(artistExternalIds.confirmed, true),
    ),
  });
  if (!spotifyArtist) throw new Error("Spotify retry requires a confirmed Spotify artist mapping");
  await queueSpotifyTrackResolutionWork(tx, {
    artistId: credit.artistId,
    dueAt: now,
    expectedSpotifyArtistId: spotifyArtist.externalId,
    mode: spotifyTrackId ? "manual" : "isrc",
    source: "repair",
    ...(spotifyTrackId ? { spotifyTrackId } : {}),
    targetIsrc: track.isrc,
    targetTrackId: trackId,
  });
}
