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

export async function loadDatabaseFeed(databaseUrl: string): Promise<FeedFixtureItem[]> {
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
    ] = await Promise.all([
      connection.db.select().from(feedItems),
      connection.db.select().from(releaseCandidates),
      connection.db.select().from(tracks),
      connection.db.select().from(releases),
      connection.db.select().from(trackCredits),
      connection.db.select().from(sourceEvidence),
      connection.db.select().from(trackAvailabilities),
      connection.db.select().from(playlistExports),
    ]);

    return feedRows.flatMap((feed, index) => {
      const candidate = candidateRows.find((row) => row.id === feed.candidateId);
      if (!candidate) return [];
      const track = trackRows.find((row) => row.id === feed.trackId);
      const release = releaseRows.find((row) => row.id === (feed.releaseId ?? track?.releaseId));
      const credits = creditRows
        .filter((row) => row.trackId === feed.trackId)
        .sort((left, right) => left.creditOrder - right.creditOrder);
      const evidence = evidenceRows.filter((row) => row.candidateId === candidate.id);
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
          links: evidence.map((row) => ({ href: row.sourceUrl, label: "Source evidence" })),
          matchReason: candidate.matchReasons.join("; "),
          region: spotify?.region ?? availabilities[0]?.region ?? "ZZ",
          releaseDate: candidate.releaseDate,
          releaseDatePrecision:
            release?.releaseDatePrecision === "year" || release?.releaseDatePrecision === "month"
              ? release.releaseDatePrecision
              : "day",
          releaseTitle: release?.title ?? candidate.title,
          releaseType: release?.releaseType ?? "other",
          soundcloudState: "NOT_CHECKED",
          sources,
          spotify: spotifyState,
          state: feed.state,
          title: track?.title ?? candidate.title,
        },
      ];
    });
  } finally {
    await connection.client.end();
  }
}

function providerLabel(provider: string): string {
  if (provider === "musicbrainz") return "MusicBrainz";
  if (provider === "spotify") return "Spotify";
  return "Mock provider";
}
