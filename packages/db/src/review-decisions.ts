import { normalizeIdentifier, normalizeText } from "@radar/core";
import { trackCandidateSchema } from "@radar/providers";
import { and, eq, ne } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artists,
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

export type FeedReviewDecision = "confirm" | "separate";

export interface FeedReviewResolution {
  decision: FeedReviewDecision;
  feedItemId: string;
  removed: boolean;
  state: "new";
}

type ReviewCandidate = ReturnType<(typeof trackCandidateSchema)["parse"]>;

export async function resolveFeedReview(
  db: RadarDatabase,
  userId: string,
  feedItemId: string,
  decision: FeedReviewDecision,
  now = new Date(),
): Promise<FeedReviewResolution | undefined> {
  return db.transaction(async (tx) => {
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
    if (candidate.matchStatus !== "needs_review") {
      return existingDecision?.decision === decision && feed.state !== "needs_review"
        ? { decision, feedItemId, removed: false, state: "new" }
        : undefined;
    }

    const payload = trackCandidateSchema.parse(candidate.rawPayload);
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
  });
}

type ReviewTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];

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
) {
  await tx
    .insert(manualMatchDecisions)
    .values({ candidateId, decidedAt, decision, reason, selectedTrackId, userId })
    .onConflictDoUpdate({
      target: manualMatchDecisions.candidateId,
      set: { decidedAt, decision, reason, selectedTrackId, userId },
    });
}
