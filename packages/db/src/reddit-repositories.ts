import {
  extractRedditLinks,
  matchRedditArtist,
  parseRedditRoundup,
  parseRedditTitle,
  redditCandidateHash,
  validateRedditEvidenceUrl,
  validateSubredditName,
  type CanonicalArtistReference,
  type RedditListing,
  type RedditParsedCandidate,
} from "@radar/providers";
import { normalizeText } from "@radar/core";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artistAliases,
  artistExternalIds,
  artistFollows,
  artists,
  feedItems,
  redditCandidateMatches,
  redditExternalLinks,
  redditParseResults,
  redditReconciliationRuns,
  redditSources,
  redditSubmissions,
  releaseCandidates,
  sourceEvidence,
  trackAvailabilities,
  trackCredits,
  tracks,
} from "./schema";

export const DEFAULT_REDDIT_SOURCES = [
  {
    displayName: "r/EDM",
    flairBoosts: ["New Music", "Music", "New EDM This Week", "New release", "Fresh", "Premiere"],
    flairExclusions: [
      "Discussion",
      "ID Help",
      "ID Request",
      "Recommendations",
      "Throwback",
      "WIP",
      "Feedback",
      "Meme",
      "Live Show",
    ],
    roundupTitlePhrases: [
      "New EDM This Week",
      "New Music Friday",
      "New Releases",
      "Fresh releases",
      "Weekly releases",
    ],
    subreddit: "EDM",
  },
  {
    displayName: "r/dubstep",
    flairBoosts: [
      "Fresh",
      "Original Content",
      "Choon",
      "Free Download",
      "New Music Friday",
      "New chune",
    ],
    flairExclusions: [
      "Discussion",
      "ID Help",
      "ID Request",
      "Recommendations",
      "Throwback",
      "WIP",
      "Feedback",
      "Meme",
      "Live Show",
    ],
    roundupTitlePhrases: ["New Music Friday", "New Releases", "Fresh releases", "Weekly releases"],
    subreddit: "dubstep",
  },
] as const;

export interface RedditSourceInput {
  displayName?: string;
  enabled?: boolean;
  flairBoosts?: string[];
  flairExclusions?: string[];
  initialBackfillDays?: number;
  maxPagesPerScan?: number;
  notes?: string;
  roundupTitlePhrases?: string[];
  scanOverlapHours?: number;
  subreddit: string;
}

export async function ensureRedditDefaultSources(db: RadarDatabase, userId: string): Promise<void> {
  for (const source of DEFAULT_REDDIT_SOURCES) {
    await db
      .insert(redditSources)
      .values({
        ...source,
        flairBoosts: [...source.flairBoosts],
        flairExclusions: [...source.flairExclusions],
        roundupTitlePhrases: [...source.roundupTitlePhrases],
        userId,
      })
      .onConflictDoNothing();
  }
}

export async function listRedditSources(db: RadarDatabase, userId: string) {
  await ensureRedditDefaultSources(db, userId);
  return db
    .select()
    .from(redditSources)
    .where(eq(redditSources.userId, userId))
    .orderBy(redditSources.subreddit);
}

export async function addRedditSource(db: RadarDatabase, userId: string, input: RedditSourceInput) {
  const validated = validateSubredditName(input.subreddit);
  if (!validated.valid) throw new Error(validated.error);
  const [source] = await db
    .insert(redditSources)
    .values({
      displayName: input.displayName?.trim() || `r/${validated.normalized}`,
      enabled: input.enabled ?? true,
      flairBoosts: cleanSignals(input.flairBoosts),
      flairExclusions: cleanSignals(input.flairExclusions),
      initialBackfillDays: boundedInteger(input.initialBackfillDays, 14, 1, 365),
      maxPagesPerScan: boundedInteger(input.maxPagesPerScan, 10, 1, 100),
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 2_000) } : {}),
      roundupTitlePhrases: cleanSignals(input.roundupTitlePhrases),
      scanOverlapHours: boundedInteger(input.scanOverlapHours, 72, 1, 720),
      subreddit: validated.normalized,
      userId,
    })
    .returning();
  if (!source) throw new Error("Failed to add Reddit source.");
  return source;
}

export async function updateRedditSource(
  db: RadarDatabase,
  userId: string,
  sourceId: string,
  input: Partial<RedditSourceInput>,
) {
  const subreddit = input.subreddit ? validateSubredditName(input.subreddit) : undefined;
  if (subreddit && !subreddit.valid) throw new Error(subreddit.error);
  const [source] = await db
    .update(redditSources)
    .set({
      ...(input.displayName !== undefined
        ? { displayName: input.displayName.trim().slice(0, 120) }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.flairBoosts !== undefined ? { flairBoosts: cleanSignals(input.flairBoosts) } : {}),
      ...(input.flairExclusions !== undefined
        ? { flairExclusions: cleanSignals(input.flairExclusions) }
        : {}),
      ...(input.initialBackfillDays !== undefined
        ? { initialBackfillDays: boundedInteger(input.initialBackfillDays, 14, 1, 365) }
        : {}),
      ...(input.maxPagesPerScan !== undefined
        ? { maxPagesPerScan: boundedInteger(input.maxPagesPerScan, 10, 1, 100) }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes.trim().slice(0, 2_000) || null } : {}),
      ...(input.roundupTitlePhrases !== undefined
        ? { roundupTitlePhrases: cleanSignals(input.roundupTitlePhrases) }
        : {}),
      ...(input.scanOverlapHours !== undefined
        ? { scanOverlapHours: boundedInteger(input.scanOverlapHours, 72, 1, 720) }
        : {}),
      ...(subreddit?.valid ? { subreddit: subreddit.normalized } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(redditSources.id, sourceId), eq(redditSources.userId, userId)))
    .returning();
  if (!source) throw new Error("Reddit source was not found.");
  return source;
}

export async function removeRedditSource(
  db: RadarDatabase,
  userId: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await db
    .delete(redditSources)
    .where(and(eq(redditSources.id, sourceId), eq(redditSources.userId, userId)))
    .returning({ id: redditSources.id });
  return rows.length > 0;
}

export async function resetRedditSourceCursor(
  db: RadarDatabase,
  userId: string,
  sourceId: string,
): Promise<void> {
  const rows = await db
    .update(redditSources)
    .set({ lastSeenCreatedAt: null, lastSeenFullname: null, updatedAt: new Date() })
    .where(and(eq(redditSources.id, sourceId), eq(redditSources.userId, userId)))
    .returning({ id: redditSources.id });
  if (rows.length === 0) throw new Error("Reddit source was not found.");
}

export interface RedditPersistenceSummary {
  duplicates: number;
  insertedCandidates: number;
  insertedSubmissions: number;
  needsReview: number;
}

export async function persistRedditListing(
  db: RadarDatabase,
  userId: string,
  sourceId: string,
  listing: RedditListing,
  now = new Date(),
): Promise<RedditPersistenceSummary> {
  const source = await db.query.redditSources.findFirst({
    where: and(eq(redditSources.id, sourceId), eq(redditSources.userId, userId)),
  });
  if (!source) throw new Error("Reddit source was not found.");
  const watchlist = await loadCanonicalWatchlist(db, userId);
  const summary: RedditPersistenceSummary = {
    duplicates: 0,
    insertedCandidates: 0,
    insertedSubmissions: 0,
    needsReview: 0,
  };

  for (const child of listing.data.children) {
    const submission = child.data;
    const existing = await db.query.redditSubmissions.findFirst({
      where: eq(redditSubmissions.fullname, submission.name),
      columns: { id: true },
    });
    if (existing) {
      summary.duplicates += 1;
      await db
        .update(redditSubmissions)
        .set({ lastCheckedAt: now, updatedAt: now })
        .where(eq(redditSubmissions.id, existing.id));
      continue;
    }

    const permalink = safeRedditPermalink(submission.permalink);
    const destination = validateRedditEvidenceUrl(submission.url);
    const [submissionRow] = await db
      .insert(redditSubmissions)
      .values({
        ...(submission.crosspost_parent
          ? { crosspostOriginFullname: submission.crosspost_parent }
          : {}),
        ...(destination.valid ? { destinationUrl: destination.link.normalizedUrl } : {}),
        ...(submission.edited && typeof submission.edited === "number"
          ? { redditEditedAt: new Date(submission.edited * 1_000) }
          : {}),
        flairText: submission.link_flair_text ?? null,
        fullname: submission.name,
        isSelfPost: submission.is_self,
        lastCheckedAt: now,
        ...(permalink ? { permalink } : {}),
        postType: submission.is_self ? "self" : "link",
        redditCreatedAt: new Date(submission.created_utc * 1_000),
        redditPostId: submission.id,
        selfText: submission.selftext,
        sourceId,
        sourceState: submission.removed_by_category ? "removed" : "active",
        subreddit: source.subreddit,
        title: submission.title,
      })
      .returning({ id: redditSubmissions.id });
    if (!submissionRow) throw new Error("Failed to persist Reddit submission.");
    summary.insertedSubmissions += 1;

    const allLinks = new Map(
      [
        ...(destination.valid ? [destination.link] : []),
        ...extractRedditLinks(submission.selftext),
      ].map((link) => [link.normalizedUrl, link]),
    );
    const isRoundup = source.roundupTitlePhrases.some((phrase) =>
      submission.title.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US")),
    );
    const parsed =
      isRoundup && submission.is_self
        ? parseRedditRoundup(submission.selftext)
        : [parseRedditTitle(submission.title, { links: [...allLinks.values()] })].filter(
            (candidate): candidate is RedditParsedCandidate => Boolean(candidate),
          );

    for (const candidate of parsed) {
      const matches = candidate.artists
        .map((artist) => ({ artist, match: matchRedditArtist(artist, watchlist) }))
        .filter((entry) => entry.match.kind !== "none");
      const best = matches.sort((left, right) => right.match.confidence - left.match.confidence)[0];
      if (!best?.match.artistId) continue;
      const candidateHash = redditCandidateHash(candidate);
      const [parseRow] = await db
        .insert(redditParseResults)
        .values({
          candidateArtistText: candidate.artistText,
          candidateHash,
          ...(candidate.label ? { candidateLabel: candidate.label } : {}),
          candidateReleaseType: candidate.classification,
          candidateTitleText: candidate.title,
          ...(candidate.version ? { candidateVersion: candidate.version } : {}),
          ...(candidate.dateEvidence?.date
            ? { claimedReleaseDate: candidate.dateEvidence.date }
            : {}),
          ...(candidate.dateEvidence ? { dateConfidence: candidate.dateEvidence.confidence } : {}),
          ...(candidate.dateEvidence ? { dateSourceText: candidate.dateEvidence.sourceText } : {}),
          failureReasons: candidate.failureReasons,
          parseConfidence: candidate.parseConfidence.toFixed(3),
          parseReasons: candidate.parseReasons,
          parserVersion: candidate.parserVersion,
          ...(candidate.sectionHeading ? { sectionHeading: candidate.sectionHeading } : {}),
          sourceLine: candidate.sourceLine ?? 0,
          submissionId: submissionRow.id,
        })
        .onConflictDoNothing()
        .returning({ id: redditParseResults.id });
      if (!parseRow) {
        summary.duplicates += 1;
        continue;
      }

      const providerTrackId = `${submission.name}:${candidateHash}`;
      const corroboratedTrackRows = await db
        .select({ releaseId: tracks.releaseId, trackId: tracks.id })
        .from(tracks)
        .innerJoin(trackCredits, eq(trackCredits.trackId, tracks.id))
        .innerJoin(trackAvailabilities, eq(trackAvailabilities.trackId, tracks.id))
        .where(
          and(
            eq(trackCredits.artistId, best.match.artistId),
            eq(tracks.normalizedTitle, normalizeText(candidate.title)),
            eq(trackAvailabilities.provider, "spotify"),
          ),
        );
      const corroboratedTracks = [
        ...new Map(corroboratedTrackRows.map((track) => [track.trackId, track])).values(),
      ];
      const corroborated = corroboratedTracks.length === 1 ? corroboratedTracks[0] : undefined;
      const [releaseCandidate] = await db
        .insert(releaseCandidates)
        .values({
          artistExternalId: best.match.artistId,
          firstSeenAt: now,
          matchConfidence: corroborated ? "1.000" : best.match.confidence.toFixed(3),
          matchReasons: [
            ...best.match.reasons,
            ...(corroborated
              ? ["Exact normalized title and canonical artist have Spotify availability"]
              : ["Reddit text requires provider corroboration or manual confirmation"]),
          ],
          matchingAlgorithmVersion: candidate.parserVersion,
          matchRule: corroborated ? "reddit_spotify_exact_title_artist" : "manual_review",
          matchStatus: corroborated ? "matched" : "needs_review",
          ...(corroborated ? { matchedTrackId: corroborated.trackId } : {}),
          normalizedTitle: candidate.title.normalize("NFKC").toLocaleLowerCase("en-US"),
          payloadHash: candidateHash,
          provider: "reddit",
          providerReleaseId: submission.name,
          providerTrackId,
          rawPayload: {
            classification: candidate.classification,
            claimedReleaseDate: candidate.dateEvidence?.date,
            redditCreatedAt: new Date(submission.created_utc * 1_000).toISOString(),
            sourceLine: candidate.sourceLine,
            subreddit: source.subreddit,
          },
          releaseDate:
            candidate.dateEvidence?.date ??
            new Date(submission.created_utc * 1_000).toISOString().slice(0, 10),
          title: candidate.title,
        })
        .onConflictDoNothing()
        .returning({ id: releaseCandidates.id });
      if (!releaseCandidate) {
        summary.duplicates += 1;
        continue;
      }

      await db.insert(redditCandidateMatches).values({
        canonicalArtistId: best.match.artistId,
        ...(corroborated?.releaseId ? { canonicalReleaseId: corroborated.releaseId } : {}),
        ...(corroborated ? { canonicalTrackId: corroborated.trackId } : {}),
        matchConfidence: corroborated ? "1.000" : best.match.confidence.toFixed(3),
        matchReasons: corroborated
          ? [...best.match.reasons, "Exact Spotify-backed canonical track corroboration"]
          : best.match.reasons,
        parseResultId: parseRow.id,
        releaseCandidateId: releaseCandidate.id,
        reviewStatus: corroborated ? "corroborated" : "needs_review",
        spotifyEvidence: corroborated
          ? { method: "exact_normalized_title_and_canonical_artist", trackId: corroborated.trackId }
          : {},
      });
      const evidenceUrl = permalink ?? "https://www.reddit.com/";
      await db.insert(sourceEvidence).values({
        candidateId: releaseCandidate.id,
        evidenceType: "reddit_submission",
        externalId: providerTrackId,
        payloadHash: candidateHash,
        provider: "reddit",
        retrievedAt: now,
        sourceUrl: evidenceUrl,
      });
      await db
        .insert(feedItems)
        .values({
          candidateId: releaseCandidate.id,
          dedupeKey: `reddit:${providerTrackId}`,
          firstSeenAt: now,
          state: candidate.dateEvidence?.date ? "upcoming" : corroborated ? "new" : "needs_review",
          userId,
        })
        .onConflictDoNothing();

      for (const link of candidate.links.length > 0 ? candidate.links : allLinks.values()) {
        const host = new URL(link.normalizedUrl).hostname;
        await db
          .insert(redditExternalLinks)
          .values({
            category: link.category,
            detectedHost: host,
            normalizedUrl: link.normalizedUrl,
            originalUrl: link.originalUrl,
            parseResultId: parseRow.id,
            submissionId: submissionRow.id,
          })
          .onConflictDoNothing();
      }
      summary.insertedCandidates += 1;
      if (!corroborated) summary.needsReview += 1;
    }

    await db
      .update(redditSources)
      .set({
        lastError: null,
        lastSeenCreatedAt: new Date(submission.created_utc * 1_000),
        lastSeenFullname: submission.name,
        lastSuccessfulScanAt: now,
        updatedAt: now,
      })
      .where(eq(redditSources.id, sourceId));
  }
  return summary;
}

export async function purgeDeletedRedditSubmissions(
  db: RadarDatabase,
  fullnames: string[],
  now = new Date(),
): Promise<{ deleted: number; preservedCanonical: number }> {
  const unique = [...new Set(fullnames)].filter((fullname) => /^t3_[a-z0-9]+$/.test(fullname));
  const [run] = await db
    .insert(redditReconciliationRuns)
    .values({ checkedCount: unique.length })
    .returning({ id: redditReconciliationRuns.id });
  if (!run) throw new Error("Failed to create Reddit reconciliation run.");
  let deleted = 0;
  let preservedCanonical = 0;
  try {
    const submissions =
      unique.length === 0
        ? []
        : await db
            .select({ id: redditSubmissions.id })
            .from(redditSubmissions)
            .where(inArray(redditSubmissions.fullname, unique));
    for (const submission of submissions) {
      const parseRows = await db
        .select({ id: redditParseResults.id })
        .from(redditParseResults)
        .where(eq(redditParseResults.submissionId, submission.id));
      const matches =
        parseRows.length === 0
          ? []
          : await db
              .select()
              .from(redditCandidateMatches)
              .where(
                inArray(
                  redditCandidateMatches.parseResultId,
                  parseRows.map((row) => row.id),
                ),
              );
      preservedCanonical += matches.filter(
        (match) => match.canonicalReleaseId !== null || match.canonicalTrackId !== null,
      ).length;
      const candidateIds = matches
        .map((match) => match.releaseCandidateId)
        .filter((id): id is string => id !== null);
      if (candidateIds.length > 0) {
        await db.delete(releaseCandidates).where(inArray(releaseCandidates.id, candidateIds));
      }
      await db.delete(redditParseResults).where(eq(redditParseResults.submissionId, submission.id));
      await db
        .delete(redditExternalLinks)
        .where(eq(redditExternalLinks.submissionId, submission.id));
      await db
        .update(redditSubmissions)
        .set({
          deletedAt: now,
          destinationUrl: null,
          flairText: null,
          lastCheckedAt: now,
          permalink: null,
          selfText: null,
          sourceState: "deleted",
          title: null,
          updatedAt: now,
        })
        .where(eq(redditSubmissions.id, submission.id));
      deleted += 1;
    }
    await db
      .update(redditReconciliationRuns)
      .set({
        completedAt: now,
        deletedCount: deleted,
        preservedCanonicalCount: preservedCanonical,
        status: "completed",
      })
      .where(eq(redditReconciliationRuns.id, run.id));
    return { deleted, preservedCanonical };
  } catch (error) {
    await db
      .update(redditReconciliationRuns)
      .set({
        completedAt: now,
        errorSummary: safeErrorSummary(error),
        status: "failed",
      })
      .where(eq(redditReconciliationRuns.id, run.id));
    throw error;
  }
}

export async function deleteAllRedditData(
  db: RadarDatabase,
  userId: string,
): Promise<{ candidatesDeleted: number; sourcesDeleted: number; submissionsDeleted: number }> {
  const sources = await db
    .select({ id: redditSources.id })
    .from(redditSources)
    .where(eq(redditSources.userId, userId));
  const submissions =
    sources.length === 0
      ? []
      : await db
          .select({ id: redditSubmissions.id })
          .from(redditSubmissions)
          .where(
            inArray(
              redditSubmissions.sourceId,
              sources.map((source) => source.id),
            ),
          );
  const candidateRows = await db
    .delete(releaseCandidates)
    .where(eq(releaseCandidates.provider, "reddit"))
    .returning({ id: releaseCandidates.id });
  const sourceRows = await db
    .delete(redditSources)
    .where(eq(redditSources.userId, userId))
    .returning({ id: redditSources.id });
  return {
    candidatesDeleted: candidateRows.length,
    sourcesDeleted: sourceRows.length,
    submissionsDeleted: submissions.length,
  };
}

export async function getRedditPersistenceStatus(db: RadarDatabase, userId: string) {
  await ensureRedditDefaultSources(db, userId);
  const sources = await db
    .select()
    .from(redditSources)
    .where(eq(redditSources.userId, userId))
    .orderBy(redditSources.subreddit);
  const [submissionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redditSubmissions)
    .innerJoin(redditSources, eq(redditSources.id, redditSubmissions.sourceId))
    .where(and(eq(redditSources.userId, userId), eq(redditSubmissions.sourceState, "active")));
  const [reviewCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redditCandidateMatches)
    .where(eq(redditCandidateMatches.reviewStatus, "needs_review"));
  const [lastReconciliation] = await db
    .select()
    .from(redditReconciliationRuns)
    .orderBy(desc(redditReconciliationRuns.startedAt))
    .limit(1);
  const [overdueCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redditSubmissions)
    .where(
      and(
        eq(redditSubmissions.sourceState, "active"),
        lt(redditSubmissions.lastCheckedAt, new Date(Date.now() - 48 * 60 * 60_000)),
        isNull(redditSubmissions.deletedAt),
      ),
    );
  return {
    activeContentRecords: submissionCount?.count ?? 0,
    awaitingReconciliation: overdueCount?.count ?? 0,
    candidatesAwaitingReview: reviewCount?.count ?? 0,
    lastReconciliation: lastReconciliation ?? null,
    sources,
  };
}

async function loadCanonicalWatchlist(
  db: RadarDatabase,
  userId: string,
): Promise<CanonicalArtistReference[]> {
  const followed = await db
    .select({ id: artists.id, name: artists.name })
    .from(artistFollows)
    .innerJoin(artists, eq(artists.id, artistFollows.artistId))
    .where(and(eq(artistFollows.userId, userId), eq(artistFollows.active, true)));
  const aliases = await db.select().from(artistAliases);
  const mappings = await db
    .select({ artistId: artistExternalIds.artistId, provider: artistExternalIds.provider })
    .from(artistExternalIds)
    .where(eq(artistExternalIds.confirmed, true));
  return followed.map((artist) => ({
    aliases: aliases.filter((alias) => alias.artistId === artist.id).map((alias) => alias.name),
    id: artist.id,
    musicbrainzNames: mappings
      .filter((mapping) => mapping.artistId === artist.id && mapping.provider === "musicbrainz")
      .map(() => artist.name),
    name: artist.name,
    spotifyNames: mappings
      .filter((mapping) => mapping.artistId === artist.id && mapping.provider === "spotify")
      .map(() => artist.name),
  }));
}

function cleanSignals(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
    .slice(0, 50)
    .map((value) => value.slice(0, 120));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function safeRedditPermalink(value: string): string | undefined {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("..")) return undefined;
  return new URL(value, "https://www.reddit.com").toString();
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown reconciliation error";
  return message.replace(/(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]").slice(0, 1_000);
}
