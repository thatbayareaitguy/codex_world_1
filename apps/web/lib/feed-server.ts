import {
  parseAppleMusicReleaseArtwork,
  parseSpotifyReleaseArtwork,
  safeProviderEvidenceUrl,
  type FeedFixtureItem,
} from "@radar/core";
import {
  createDatabase,
  playlistExports,
  releaseCandidates,
  releaseExternalIds,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  releases,
  sourceEvidence,
  spotifyReleaseTrackRetrievals,
  trackAvailabilities,
  trackCredits,
  tracks,
} from "@radar/db";
import { inArray } from "drizzle-orm";

import {
  createFeedCursor,
  parseFeedCursor,
  type FeedCursorPosition,
  type FeedQueryFilters,
} from "./feed-cursor";
import { formatFeedArtistCredits } from "./feed-format";

export interface DatabaseFeedRevision {
  count: number;
  revision: string;
}

export interface DatabaseFeedSummary {
  needsReview: number;
  newThisWeek: number;
  upcoming: number;
}

export interface DatabaseFeedPage extends DatabaseFeedRevision {
  hasMore: boolean;
  items: FeedFixtureItem[];
  nextCursor: string | null;
  summary: DatabaseFeedSummary;
  totalCount: number;
}

export type DatabaseFeedSnapshot = DatabaseFeedPage;

export interface FeedPageOptions {
  cursor?: string;
  filters?: Partial<FeedQueryFilters>;
  limit?: number;
  secret: string;
}

interface FeedGroupRow {
  cumulative_count: string | number;
  feed_ids: string[];
  first_seen_at: Date;
  group_key: string;
  has_more_after: boolean;
  item_count: string | number;
  release_date: string;
  release_precision: string | number;
  stable_id: string;
  total_count: string | number;
}

interface FeedSummaryRow {
  needs_review: string | number;
  new_this_week: string | number;
  upcoming: string | number;
}

const defaultFilters: FeedQueryFilters = { sort: "release" };

export async function loadDatabaseFeed(databaseUrl: string): Promise<FeedFixtureItem[]> {
  return (await loadDatabaseFeedSnapshot(databaseUrl, "local-feed-cursor")).items;
}

export async function loadDatabaseFeedRevision(databaseUrl: string): Promise<DatabaseFeedRevision> {
  const connection = createDatabase(databaseUrl);
  try {
    const row = await connection.db.query.feedRevisions.findFirst({
      where: (revision, operators) => operators.eq(revision.id, "global"),
    });
    return {
      count: row?.itemCount ?? 0,
      revision: `${row?.revision ?? 0}:${row?.updatedAt.toISOString() ?? "empty"}`,
    };
  } finally {
    await connection.client.end();
  }
}

export async function loadDatabaseFeedSnapshot(
  databaseUrl: string,
  secret = "local-feed-cursor",
): Promise<DatabaseFeedSnapshot> {
  return loadDatabaseFeedPage(databaseUrl, { secret });
}

export async function loadDatabaseFeedPage(
  databaseUrl: string,
  options: FeedPageOptions,
): Promise<DatabaseFeedPage> {
  const connection = createDatabase(databaseUrl);
  const filters = normalizeFeedFilters(options.filters);
  const limit = Math.max(25, Math.min(Math.trunc(options.limit ?? 100), 200));
  const cursor = options.cursor
    ? parseFeedCursor(options.cursor, filters, options.secret)
    : undefined;

  try {
    const [groupRows, revisionRow, summaryRows] = await Promise.all([
      selectFeedGroups(connection.client, filters, limit, cursor),
      connection.db.query.feedRevisions.findFirst({
        where: (revision, operators) => operators.eq(revision.id, "global"),
      }),
      connection.client.unsafe<FeedSummaryRow[]>(`
        SELECT
          count(*) FILTER (
            WHERE "feed_items"."first_seen_at" >= date_trunc('week', current_timestamp)
          ) AS "new_this_week",
          count(*) FILTER (WHERE "feed_items"."state" = 'needs_review') AS "needs_review",
          count(*) FILTER (
            WHERE COALESCE("releases"."release_date", "release_candidates"."release_date")
              BETWEEN current_date AND current_date + 30
          ) AS "upcoming"
        FROM "feed_items"
        LEFT JOIN "release_candidates" ON "release_candidates"."id" = "feed_items"."candidate_id"
        LEFT JOIN "tracks" ON "tracks"."id" = "feed_items"."track_id"
        LEFT JOIN "release_track_appearances"
          ON "release_track_appearances"."id" = "feed_items"."appearance_id"
        LEFT JOIN "releases" ON "releases"."id" = COALESCE(
          "release_track_appearances"."release_id",
          "feed_items"."release_id",
          "tracks"."release_id"
        )
        WHERE "feed_items"."user_id" = (
          SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1
        )
      `),
    ]);
    const selectedGroups = groupRows.filter(
      (row, index) => index === 0 || Number(row.cumulative_count) <= limit,
    );
    const groupKeys = selectedGroups.map((row) => row.group_key);
    const selectedFeedIds = selectedGroups.flatMap((row) => row.feed_ids);
    const projected = await projectFeedItems(connection.db, selectedFeedIds);
    const order = new Map(groupKeys.map((key, index) => [key, index]));
    const items = projected.sort(
      (left, right) =>
        (order.get(feedGroupKey(left)) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(feedGroupKey(right)) ?? Number.MAX_SAFE_INTEGER) ||
        compareAppearanceOrder(left, right),
    );
    const lastGroup = selectedGroups.at(-1);
    const hasMore = Boolean(lastGroup?.has_more_after);
    const nextCursor =
      hasMore && lastGroup
        ? createFeedCursor(cursorPosition(lastGroup), filters, options.secret)
        : null;
    const summary = summaryRows[0];
    return {
      count: revisionRow?.itemCount ?? 0,
      hasMore,
      items,
      nextCursor,
      revision: `${revisionRow?.revision ?? 0}:${revisionRow?.updatedAt.toISOString() ?? "empty"}`,
      summary: {
        needsReview: Number(summary?.needs_review ?? 0),
        newThisWeek: Number(summary?.new_this_week ?? 0),
        upcoming: Number(summary?.upcoming ?? 0),
      },
      totalCount: Number(groupRows[0]?.total_count ?? 0),
    };
  } finally {
    await connection.client.end();
  }
}

function normalizeFeedFilters(input: Partial<FeedQueryFilters> | undefined): FeedQueryFilters {
  const filters = { ...defaultFilters, ...input };
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
  ) as unknown as FeedQueryFilters;
}

async function selectFeedGroups(
  client: ReturnType<typeof createDatabase>["client"],
  filters: FeedQueryFilters,
  limit: number,
  cursor: FeedCursorPosition | undefined,
): Promise<FeedGroupRow[]> {
  const parameters: Array<boolean | Date | null | number | string> = [];
  const bind = (value: boolean | Date | null | number | string) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const clauses = [
    `"feed"."user_id" = (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1)`,
  ];
  if (filters.state === "saved") {
    clauses.push(`("feed"."saved_at" IS NOT NULL OR "feed"."state" = 'saved')`);
  } else if (filters.state === "listened") {
    clauses.push(`("feed"."listened_at" IS NOT NULL OR "feed"."state" = 'listened')`);
  } else if (filters.state) {
    clauses.push(`"feed"."state" = ${bind(filters.state)}::feed_state`);
  }
  if (filters.releaseType) {
    clauses.push(`"release"."release_type"::text = ${bind(filters.releaseType)}`);
  }
  if (filters.dateFrom) {
    clauses.push(
      `COALESCE("release"."release_date", "candidate"."release_date") >= ${bind(filters.dateFrom)}::date`,
    );
  }
  if (filters.dateTo) {
    clauses.push(
      `COALESCE("release"."release_date", "candidate"."release_date") <= ${bind(filters.dateTo)}::date`,
    );
  }
  if (filters.exactOnly) clauses.push(`"candidate"."match_confidence" = 1`);
  if (filters.spotify === "available") {
    clauses.push(spotifyMatchExistsSql());
  } else if (filters.spotify === "unavailable") {
    clauses.push(`NOT (${spotifyMatchExistsSql()})`);
  }
  if (filters.provider) {
    const provider = bind(filters.provider);
    clauses.push(`(
      EXISTS (
        SELECT 1 FROM "source_evidence" "evidence"
        WHERE "evidence"."candidate_id" = "feed"."candidate_id"
          AND "evidence"."provider" = ${provider}::provider
      ) OR EXISTS (
        SELECT 1
        FROM "release_track_appearance_sources" "appearance_source"
        JOIN "source_evidence" "evidence"
          ON "evidence"."candidate_id" = "appearance_source"."candidate_id"
        WHERE "appearance_source"."appearance_id" = "feed"."appearance_id"
          AND "evidence"."provider" = ${provider}::provider
      )
    )`);
  }
  if (filters.artist) {
    const artist = bind(filters.artist.toLowerCase());
    clauses.push(`(
      lower("candidate"."artist_external_id") = ${artist}
      OR EXISTS (
        SELECT 1 FROM "track_credits" "credit"
        WHERE "credit"."track_id" = "feed"."track_id"
          AND lower("credit"."credited_name") = ${artist}
      )
    )`);
  }
  if (filters.search) {
    const search = bind(`%${escapeLike(filters.search.toLowerCase())}%`);
    clauses.push(`(
      lower("candidate"."title") LIKE ${search} ESCAPE '\\'
      OR lower(COALESCE("track"."title", '')) LIKE ${search} ESCAPE '\\'
      OR lower(COALESCE("release"."title", '')) LIKE ${search} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM "track_credits" "credit"
        WHERE "credit"."track_id" = "feed"."track_id"
          AND lower("credit"."credited_name") LIKE ${search} ESCAPE '\\'
      )
    )`);
  }

  const releaseOrder = `"release_date" DESC, "release_precision" DESC, "first_seen_at" DESC, "stable_id" DESC`;
  const firstSeenOrder = `"first_seen_at" DESC, "release_date" DESC, "release_precision" DESC, "stable_id" DESC`;
  const order = filters.sort === "first-seen" ? firstSeenOrder : releaseOrder;
  let cursorClause = "TRUE";
  if (cursor) {
    const releaseDate = bind(cursor.releaseDate);
    const releasePrecision = bind(cursor.releasePrecision);
    const firstSeenAt = bind(cursor.firstSeenAt);
    const stableId = bind(cursor.stableId);
    cursorClause =
      filters.sort === "first-seen"
        ? `("first_seen_at", "release_date", "release_precision", "stable_id") < (${firstSeenAt}::timestamptz, ${releaseDate}::date, ${releasePrecision}::integer, ${stableId}::uuid)`
        : `("release_date", "release_precision", "first_seen_at", "stable_id") < (${releaseDate}::date, ${releasePrecision}::integer, ${firstSeenAt}::timestamptz, ${stableId}::uuid)`;
  }
  const limitParameter = bind(limit);
  const splitFutureReleaseGroups =
    filters.state === "new"
      ? `COALESCE("release"."release_date", "candidate"."release_date") > current_date`
      : "FALSE";
  const query = `
    WITH "filtered" AS MATERIALIZED (
      SELECT
        "feed"."id",
        CASE
          WHEN ${splitFutureReleaseGroups} THEN 'feed:' || "feed"."id"::text
          ELSE COALESCE("release"."id"::text, 'feed:' || "feed"."id"::text)
        END AS "group_key",
        COALESCE("release"."release_date", "candidate"."release_date") AS "release_date",
        CASE COALESCE("release"."release_date_precision", 'day')
          WHEN 'day' THEN 3 WHEN 'month' THEN 2 ELSE 1
        END AS "release_precision",
        "feed"."first_seen_at"
      FROM "feed_items" "feed"
      JOIN "release_candidates" "candidate" ON "candidate"."id" = "feed"."candidate_id"
      LEFT JOIN "tracks" "track" ON "track"."id" = "feed"."track_id"
      LEFT JOIN "release_track_appearances" "appearance" ON "appearance"."id" = "feed"."appearance_id"
      LEFT JOIN "releases" "release"
        ON "release"."id" = COALESCE("appearance"."release_id", "feed"."release_id", "track"."release_id")
      WHERE ${clauses.join(" AND ")}
    ),
    "grouped" AS (
      SELECT
        "group_key",
        max("release_date") AS "release_date",
        max("release_precision") AS "release_precision",
        max("first_seen_at") AS "first_seen_at",
        min("id"::text)::uuid AS "stable_id",
        array_agg("id" ORDER BY "first_seen_at" DESC, "id") AS "feed_ids",
        count(*)::integer AS "item_count"
      FROM "filtered"
      GROUP BY "group_key"
    ),
    "remaining" AS (
      SELECT * FROM "grouped" WHERE ${cursorClause}
    ),
    "ranked" AS (
      SELECT
        *,
        sum("item_count") OVER (ORDER BY ${order}) AS "cumulative_count",
        lead("group_key") OVER (ORDER BY ${order}) IS NOT NULL AS "has_more_after",
        (SELECT count(*) FROM "filtered") AS "total_count"
      FROM "remaining"
    )
    SELECT * FROM "ranked"
    WHERE "cumulative_count" <= ${limitParameter} OR "cumulative_count" = "item_count"
    ORDER BY ${order}
  `;
  return client.unsafe<FeedGroupRow[]>(query, parameters);
}

async function projectFeedItems(
  db: ReturnType<typeof createDatabase>["db"],
  feedIds: string[],
): Promise<FeedFixtureItem[]> {
  if (feedIds.length === 0) return [];
  const feedRows = await db.query.feedItems.findMany({
    where: (feed, operators) => operators.inArray(feed.id, feedIds),
  });
  if (feedRows.length === 0) return [];

  const directCandidateIds = compact(feedRows.map((row) => row.candidateId));
  const trackIds = compact(feedRows.map((row) => row.trackId));
  const appearanceIds = compact(feedRows.map((row) => row.appearanceId));
  const [trackRows, appearanceRows] = await Promise.all([
    trackIds.length ? db.select().from(tracks).where(inArray(tracks.id, trackIds)) : [],
    appearanceIds.length
      ? db
          .select()
          .from(releaseTrackAppearances)
          .where(inArray(releaseTrackAppearances.id, appearanceIds))
      : [],
  ]);
  const appearanceSourceRows = appearanceIds.length
    ? await db
        .select()
        .from(releaseTrackAppearanceSources)
        .where(inArray(releaseTrackAppearanceSources.appearanceId, appearanceIds))
    : [];
  const sourceCandidateIds = appearanceSourceRows.map((row) => row.candidateId);
  const candidateRows = await db
    .select()
    .from(releaseCandidates)
    .where(
      inArray(releaseCandidates.id, [...new Set([...directCandidateIds, ...sourceCandidateIds])]),
    );
  const resolvedReleaseIds = compact([
    ...feedRows.map((row) => row.releaseId),
    ...appearanceRows.map((row) => row.releaseId),
    ...trackRows.map((row) => row.releaseId),
  ]);
  const evidenceCandidateIds = [...new Set([...directCandidateIds, ...sourceCandidateIds])];
  const [
    releaseRows,
    releaseExternalIdRows,
    creditRows,
    evidenceRows,
    availabilityRows,
    exportRows,
    releaseTrackRetrievalRows,
  ] = await Promise.all([
    resolvedReleaseIds.length
      ? db.select().from(releases).where(inArray(releases.id, resolvedReleaseIds))
      : [],
    resolvedReleaseIds.length
      ? db
          .select()
          .from(releaseExternalIds)
          .where(inArray(releaseExternalIds.releaseId, resolvedReleaseIds))
      : [],
    trackIds.length
      ? db.select().from(trackCredits).where(inArray(trackCredits.trackId, trackIds))
      : [],
    evidenceCandidateIds.length
      ? db
          .select()
          .from(sourceEvidence)
          .where(inArray(sourceEvidence.candidateId, evidenceCandidateIds))
      : [],
    trackIds.length
      ? db.select().from(trackAvailabilities).where(inArray(trackAvailabilities.trackId, trackIds))
      : [],
    trackIds.length
      ? db.select().from(playlistExports).where(inArray(playlistExports.trackId, trackIds))
      : [],
    resolvedReleaseIds.length
      ? db
          .select()
          .from(spotifyReleaseTrackRetrievals)
          .where(inArray(spotifyReleaseTrackRetrievals.releaseId, resolvedReleaseIds))
      : [],
  ]);

  const candidateById = mapBy(candidateRows, (row) => row.id);
  const trackById = mapBy(trackRows, (row) => row.id);
  const appearanceById = mapBy(appearanceRows, (row) => row.id);
  const releaseById = mapBy(releaseRows, (row) => row.id);
  const creditsByTrack = groupBy(creditRows, (row) => row.trackId);
  const candidateIdsByAppearance = groupBy(appearanceSourceRows, (row) => row.appearanceId);
  const evidenceByCandidate = groupBy(evidenceRows, (row) => row.candidateId);
  const externalByRelease = groupBy(releaseExternalIdRows, (row) => row.releaseId);
  const availabilityByTrack = groupBy(availabilityRows, (row) => row.trackId);
  const retrievalByRelease = mapBy(releaseTrackRetrievalRows, (row) => row.releaseId ?? "");
  const exportedTrackIds = new Set(
    exportRows.filter((row) => row.status === "exported").map((row) => row.trackId),
  );

  return feedRows.flatMap((feed) => {
    const candidate = feed.candidateId ? candidateById.get(feed.candidateId) : undefined;
    if (!candidate) return [];
    const track = feed.trackId ? trackById.get(feed.trackId) : undefined;
    const appearance = feed.appearanceId ? appearanceById.get(feed.appearanceId) : undefined;
    const release = releaseById.get(
      appearance?.releaseId ?? feed.releaseId ?? track?.releaseId ?? "",
    );
    const credits = [...(feed.trackId ? (creditsByTrack.get(feed.trackId) ?? []) : [])].sort(
      (left, right) => left.creditOrder - right.creditOrder,
    );
    const appearanceCandidateIds = appearance
      ? (candidateIdsByAppearance.get(appearance.id) ?? []).map((row) => row.candidateId)
      : [];
    const relatedCandidateIds = appearanceCandidateIds.length
      ? appearanceCandidateIds
      : [candidate.id];
    const evidence = relatedCandidateIds.flatMap((id) => evidenceByCandidate.get(id) ?? []);
    const safeEvidence = evidence.flatMap((row) => {
      const href = safeProviderEvidenceUrl(row.provider, row.sourceUrl);
      return href ? [{ ...row, href }] : [];
    });
    const hasSpotifyEvidence = safeEvidence.some((row) => row.provider === "spotify");
    const hasAppleMusicEvidence = safeEvidence.some((row) => row.provider === "apple_music");
    const storedSpotifyArtwork = (externalByRelease.get(release?.id ?? "") ?? [])
      .filter((row) => row.provider === "spotify")
      .map((row) => parseSpotifyReleaseArtwork(providerField(row.providerFields, "spotify")))
      .find((artwork) => artwork !== null);
    const spotifyArtwork = hasSpotifyEvidence
      ? (storedSpotifyArtwork ??
        parseSpotifyReleaseArtwork(providerField(candidate.rawPayload, "spotifyRelease")))
      : null;
    const storedAppleMusicArtwork = (externalByRelease.get(release?.id ?? "") ?? [])
      .filter((row) => row.provider === "apple_music")
      .map((row) => parseAppleMusicReleaseArtwork(providerField(row.providerFields, "apple_music")))
      .find((artwork) => artwork !== null);
    const appleMusicArtwork = hasAppleMusicEvidence
      ? (storedAppleMusicArtwork ??
        parseAppleMusicReleaseArtwork(providerField(candidate.rawPayload, "appleMusicRelease")))
      : null;
    const completeness = retrievalByRelease.get(release?.id ?? "");
    const availabilities = feed.trackId ? (availabilityByTrack.get(feed.trackId) ?? []) : [];
    const spotify = availabilities.find((row) => row.provider === "spotify");
    const spotifyState =
      hasSpotifyEvidence || spotify?.state === "playable"
        ? "playable"
        : (spotify?.state ?? "unavailable");
    const exact = candidate.matchRule.startsWith("exact_");
    return [
      {
        accent: accentFor(feed.id),
        artist: credits.length ? formatFeedArtistCredits(credits) : candidate.artistExternalId,
        confidence: Number(candidate.matchConfidence),
        ...(appearance ? { discNumber: appearance.discNumber } : {}),
        exportStatus: exportedTrackIds.has(feed.trackId ?? "")
          ? "exported"
          : feed.state === "needs_review"
            ? "review_required"
            : spotifyState === "playable" && exact
              ? "eligible"
              : "blocked",
        firstSeenAt: feed.firstSeenAt.toISOString(),
        id: feed.id,
        links: safeEvidence.map((row) => ({ href: row.href, label: "Source evidence" })),
        listened: feed.listenedAt !== null || feed.state === "listened",
        matchReason: candidate.matchReasons.join("; "),
        ...(appearance?.providerOrder != null ? { providerOrder: appearance.providerOrder } : {}),
        region: spotify?.region ?? availabilities[0]?.region ?? "ZZ",
        ...(release ? { releaseId: release.id } : {}),
        ...(completeness
          ? {
              releaseCompleteness: {
                expectedTracks: completeness.expectedTotalTracks,
                fetchedTracks: completeness.fetchedTrackCount,
                missingTracks: Math.max(
                  0,
                  completeness.expectedTotalTracks - completeness.fetchedTrackCount,
                ),
                status: completeness.status,
              },
            }
          : {}),
        releaseDate: candidate.releaseDate,
        ...(release ? { releaseGroupDate: release.releaseDate } : {}),
        releaseDatePrecision:
          release?.releaseDatePrecision === "year" || release?.releaseDatePrecision === "month"
            ? release.releaseDatePrecision
            : "day",
        releaseTitle: release?.title ?? candidate.title,
        releaseType: release?.releaseType ?? "other",
        saved: feed.savedAt !== null || feed.state === "saved",
        soundcloudState: "NOT_CHECKED",
        sources: safeEvidence.map((row) => ({
          evidenceHref: row.href,
          href: row.href,
          provider: providerLabel(row.provider),
        })),
        spotify: spotifyState,
        ...(appleMusicArtwork ? { appleMusicArtwork } : {}),
        ...(spotifyArtwork ? { spotifyArtwork } : {}),
        state: feed.state === "saved" || feed.state === "listened" ? "new" : feed.state,
        title: track?.title ?? candidate.title,
        ...(appearance ? { trackNumber: appearance.trackNumber } : {}),
      } satisfies FeedFixtureItem,
    ];
  });
}

function cursorPosition(row: FeedGroupRow): FeedCursorPosition {
  return {
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    releaseDate: row.release_date,
    releasePrecision: Number(row.release_precision),
    stableId: row.stable_id,
  };
}

function feedGroupKey(item: FeedFixtureItem): string {
  return item.releaseId ?? `feed:${item.id}`;
}

function compareAppearanceOrder(left: FeedFixtureItem, right: FeedFixtureItem): number {
  return (
    (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
    (left.trackNumber ?? left.providerOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.trackNumber ?? right.providerOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function mapBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function compact(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function providerField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerLabel(provider: string): string {
  if (provider === "musicbrainz") return "MusicBrainz";
  if (provider === "spotify") return "Spotify";
  if (provider === "apple_music") return "Apple Music";
  if (provider === "reddit") return "Reddit";
  return "Mock provider";
}

function accentFor(id: string): FeedFixtureItem["accent"] {
  const accents: FeedFixtureItem["accent"][] = ["coral", "cyan", "lime", "gold"];
  return accents[
    id.split("").reduce((total, character) => total + character.charCodeAt(0), 0) % 4
  ]!;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function spotifyMatchExistsSql(): string {
  return `(
    EXISTS (
      SELECT 1 FROM "track_availabilities" "availability"
      WHERE "availability"."track_id" = "feed"."track_id"
        AND "availability"."provider" = 'spotify'
        AND "availability"."state" = 'playable'
    ) OR EXISTS (
      SELECT 1 FROM "source_evidence" "spotify_evidence"
      WHERE "spotify_evidence"."candidate_id" = "feed"."candidate_id"
        AND "spotify_evidence"."provider" = 'spotify'
    ) OR EXISTS (
      SELECT 1
      FROM "release_track_appearance_sources" "spotify_appearance_source"
      JOIN "source_evidence" "spotify_appearance_evidence"
        ON "spotify_appearance_evidence"."candidate_id" = "spotify_appearance_source"."candidate_id"
      WHERE "spotify_appearance_source"."appearance_id" = "feed"."appearance_id"
        AND "spotify_appearance_evidence"."provider" = 'spotify'
    )
  )`;
}
