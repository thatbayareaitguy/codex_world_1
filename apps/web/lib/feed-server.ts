import type { FeedFixtureItem } from "@radar/core";
import {
  createDatabase,
  feedItems,
  playlistExports,
  releaseCandidates,
  releases,
  sourceEvidence,
  trackAvailabilities,
  trackCredits,
  tracks,
} from "@radar/db";
import { count, max } from "drizzle-orm";

export interface DatabaseFeedRevision {
  count: number;
  revision: string;
}

export interface DatabaseFeedSnapshot extends DatabaseFeedRevision {
  items: FeedFixtureItem[];
}

export async function loadDatabaseFeed(databaseUrl: string): Promise<FeedFixtureItem[]> {
  return (await loadDatabaseFeedSnapshot(databaseUrl)).items;
}

export async function loadDatabaseFeedRevision(databaseUrl: string): Promise<DatabaseFeedRevision> {
  const connection = createDatabase(databaseUrl);
  try {
    const [revisionRow] = await connection.db
      .select({ count: count(), updatedAt: max(feedItems.updatedAt) })
      .from(feedItems);
    return toFeedRevision(revisionRow);
  } finally {
    await connection.client.end();
  }
}

export async function loadDatabaseFeedSnapshot(databaseUrl: string): Promise<DatabaseFeedSnapshot> {
  const connection = createDatabase(databaseUrl);
  try {
    const [
      feedRows,
      candidateRows,
      trackRows,
      releaseRows,
      creditRows,
      evidenceRows,
      availabilityRows,
      exportRows,
      revisionRows,
    ] = await Promise.all([
      connection.db.select().from(feedItems),
      connection.db.select().from(releaseCandidates),
      connection.db.select().from(tracks),
      connection.db.select().from(releases),
      connection.db.select().from(trackCredits),
      connection.db.select().from(sourceEvidence),
      connection.db.select().from(trackAvailabilities),
      connection.db.select().from(playlistExports),
      connection.db.select({ count: count(), updatedAt: max(feedItems.updatedAt) }).from(feedItems),
    ]);

    const items: FeedFixtureItem[] = feedRows.flatMap((feed, index) => {
      const candidate = candidateRows.find((row) => row.id === feed.candidateId);
      if (!candidate) return [];
      const track = trackRows.find((row) => row.id === feed.trackId);
      const release = releaseRows.find((row) => row.id === (feed.releaseId ?? track?.releaseId));
      const credits = creditRows
        .filter((row) => row.trackId === feed.trackId)
        .sort((left, right) => left.creditOrder - right.creditOrder);
      const relatedCandidateIds = new Set(
        candidateRows
          .filter((row) =>
            feed.trackId ? row.matchedTrackId === feed.trackId : row.id === candidate.id,
          )
          .map((row) => row.id),
      );
      const evidence = evidenceRows.filter((row) => relatedCandidateIds.has(row.candidateId));
      const availabilities = availabilityRows.filter((row) => row.trackId === feed.trackId);
      const spotify = availabilities.find((row) => row.provider === "spotify");
      const exported = exportRows.some(
        (row) => row.trackId === feed.trackId && row.status === "exported",
      );
      const artist = credits.length
        ? credits
            .map((credit, creditIndex) =>
              credit.role === "featured" && creditIndex > 0
                ? `feat. ${credit.creditedName}`
                : credit.creditedName,
            )
            .join(" ")
        : candidate.artistExternalId;
      const sources = evidence.map((row) => ({
        evidenceHref: row.sourceUrl,
        href: row.sourceUrl,
        provider: providerLabel(row.provider),
      }));
      const exact = candidate.matchRule.startsWith("exact_");
      const spotifyState = spotify?.state ?? "unavailable";
      const primaryState = feed.state === "saved" || feed.state === "listened" ? "new" : feed.state;
      return [
        {
          accent: ["coral", "cyan", "lime", "gold"][index % 4] as FeedFixtureItem["accent"],
          artist,
          confidence: Number(candidate.matchConfidence),
          exportStatus: exported
            ? "exported"
            : feed.state === "needs_review"
              ? "review_required"
              : spotifyState === "playable" && exact
                ? "eligible"
                : "blocked",
          firstSeenAt: feed.firstSeenAt.toISOString(),
          id: feed.id,
          listened: feed.listenedAt !== null || feed.state === "listened",
          links: evidence.map((row) => ({ href: row.sourceUrl, label: "Source evidence" })),
          matchReason: candidate.matchReasons.join("; "),
          region: spotify?.region ?? availabilities[0]?.region ?? "ZZ",
          ...(release ? { releaseId: release.id } : {}),
          releaseDate: candidate.releaseDate,
          releaseDatePrecision:
            release?.releaseDatePrecision === "year" || release?.releaseDatePrecision === "month"
              ? release.releaseDatePrecision
              : "day",
          releaseTitle: release?.title ?? candidate.title,
          releaseType: release?.releaseType ?? "other",
          saved: feed.savedAt !== null || feed.state === "saved",
          soundcloudState: "NOT_CHECKED",
          sources,
          spotify: spotifyState,
          state: primaryState,
          title: track?.title ?? candidate.title,
        },
      ];
    });
    return { items, ...toFeedRevision(revisionRows[0]) };
  } finally {
    await connection.client.end();
  }
}

function toFeedRevision(row: { count: number; updatedAt: Date | null } | undefined) {
  const itemCount = row?.count ?? 0;
  const updatedAt = row?.updatedAt?.toISOString() ?? "empty";
  return { count: itemCount, revision: `${updatedAt}:${itemCount}` };
}

function providerLabel(provider: string): string {
  if (provider === "musicbrainz") return "MusicBrainz";
  if (provider === "spotify") return "Spotify";
  return "Mock provider";
}
