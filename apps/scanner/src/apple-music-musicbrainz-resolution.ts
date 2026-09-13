import { normalizeText } from "@radar/core";
import {
  confirmAppleIdentityFromMusicBrainzEvidence,
  type AppleIdentityResolutionBatchRow,
  type RadarDatabase,
} from "@radar/db";
import type {
  AppleMusicAlbum,
  AppleMusicArtist,
  AppleMusicClient,
  MusicBrainzClient,
  MusicBrainzReleaseGroup,
} from "@radar/providers";
import { parseAppleMusicArtistId } from "./apple-music-identity-workflow";

export interface MusicBrainzAppleCandidateEvidence {
  albumMatches: Array<{ appleTitle: string; musicBrainzTitle: string }>;
  appleArtist: AppleMusicArtist;
  contradictoryDates: string[];
  exactName: boolean;
  primaryAlbums: number;
}

export interface MusicBrainzAppleResolutionEvaluation {
  candidates: MusicBrainzAppleCandidateEvidence[];
  confirmedAppleArtistId: string | null;
  reason: string;
}

export function evaluateMusicBrainzAppleCandidates(
  musicBrainzArtistId: string,
  releaseGroups: MusicBrainzReleaseGroup[],
  candidates: Array<{ albums: AppleMusicAlbum[]; artist: AppleMusicArtist }>,
): MusicBrainzAppleResolutionEvaluation {
  const primaryGroups = releaseGroups.filter((group) =>
    group["artist-credit"].some((credit) => credit.artist.id === musicBrainzArtistId),
  );
  const musicBrainzNames = new Set(
    primaryGroups.flatMap((group) =>
      group["artist-credit"]
        .filter((credit) => credit.artist.id === musicBrainzArtistId)
        .flatMap((credit) => [normalizeText(credit.name), normalizeText(credit.artist.name)]),
    ),
  );
  const groupsByTitle = new Map<string, MusicBrainzReleaseGroup[]>();
  for (const group of primaryGroups) {
    const key = normalizeText(group.title);
    groupsByTitle.set(key, [...(groupsByTitle.get(key) ?? []), group]);
  }
  const evaluated = candidates.map(({ albums, artist }) => {
    const primaryAlbums = albums.filter((album) => album.artistIds.includes(artist.artistId));
    const albumMatches: MusicBrainzAppleCandidateEvidence["albumMatches"] = [];
    const contradictoryDates: string[] = [];
    const matchedTitles = new Set<string>();
    for (const album of primaryAlbums) {
      const releaseDate = album.releaseDate;
      const key = normalizeText(album.title);
      const groups = groupsByTitle.get(key) ?? [];
      if (!groups.length || matchedTitles.has(key)) continue;
      matchedTitles.add(key);
      albumMatches.push({ appleTitle: album.title, musicBrainzTitle: groups[0]!.title });
      if (
        releaseDate &&
        groups.every(
          (group) =>
            group["first-release-date"] && datesConflict(releaseDate, group["first-release-date"]),
        )
      ) {
        contradictoryDates.push(album.title);
      }
    }
    return {
      albumMatches,
      appleArtist: artist,
      contradictoryDates,
      exactName: musicBrainzNames.has(normalizeText(artist.name)),
      primaryAlbums: primaryAlbums.length,
    };
  });
  const eligible = evaluated
    .filter(
      (candidate) =>
        candidate.exactName &&
        candidate.albumMatches.length >= 2 &&
        candidate.contradictoryDates.length === 0,
    )
    .sort(
      (left, right) =>
        right.albumMatches.length - left.albumMatches.length ||
        left.appleArtist.artistId.localeCompare(right.appleArtist.artistId),
    );
  if (eligible.length === 0) {
    return {
      candidates: evaluated,
      confirmedAppleArtistId: null,
      reason:
        "No candidate had exact MusicBrainz name agreement and two consistent primary-release title matches.",
    };
  }
  if (
    eligible.length > 1 &&
    eligible[0]!.albumMatches.length === eligible[1]!.albumMatches.length
  ) {
    return {
      candidates: evaluated,
      confirmedAppleArtistId: null,
      reason:
        "Multiple Apple profiles received equally strong independent MusicBrainz catalog evidence.",
    };
  }
  return {
    candidates: evaluated,
    confirmedAppleArtistId: eligible[0]!.appleArtist.artistId,
    reason: `${eligible[0]!.albumMatches.length} exact primary-release title matches with exact MusicBrainz artist-name agreement.`,
  };
}

export async function runBoundedMusicBrainzAppleResolution(input: {
  appleClient: Pick<AppleMusicClient, "getArtistAlbumsFirstPage" | "getArtists">;
  db: RadarDatabase;
  limit: number;
  maxCandidates: number;
  musicBrainzClient: Pick<MusicBrainzClient, "browseReleaseGroupsFirstPage">;
  rows: AppleIdentityResolutionBatchRow[];
}): Promise<{
  appleRequests: number;
  evaluated: number;
  musicBrainzRequests: number;
  resolved: number;
  results: Array<{ artistId: string; reason: string; resolvedAppleArtistId: string | null }>;
}> {
  const selected = input.rows
    .filter((row) => row.musicBrainzId && row.appleCandidateUrls.length)
    .slice(0, Math.max(1, Math.min(Math.trunc(input.limit), 25)));
  let appleRequests = 0;
  let musicBrainzRequests = 0;
  let resolved = 0;
  const results: Array<{ artistId: string; reason: string; resolvedAppleArtistId: string | null }> =
    [];
  for (const row of selected) {
    const musicBrainzId = row.musicBrainzId!;
    const candidateIds = row.appleCandidateUrls
      .slice(0, Math.max(1, Math.min(Math.trunc(input.maxCandidates), 5)))
      .map(parseAppleMusicArtistId);
    const releaseGroups = await input.musicBrainzClient.browseReleaseGroupsFirstPage(musicBrainzId);
    musicBrainzRequests += 1;
    const batch = await input.appleClient.getArtists(candidateIds);
    appleRequests += 1;
    const candidates: Array<{ albums: AppleMusicAlbum[]; artist: AppleMusicArtist }> = [];
    for (const artist of batch.items) {
      const albums = await input.appleClient.getArtistAlbumsFirstPage(
        artist.artistId,
        `musicbrainz_identity:${row.artistId}`,
      );
      appleRequests += 1;
      candidates.push({ albums: albums.items, artist });
    }
    const evaluation = evaluateMusicBrainzAppleCandidates(musicBrainzId, releaseGroups, candidates);
    if (evaluation.confirmedAppleArtistId) {
      const winner = evaluation.candidates.find(
        (candidate) => candidate.appleArtist.artistId === evaluation.confirmedAppleArtistId,
      )!;
      await confirmAppleIdentityFromMusicBrainzEvidence(input.db, {
        appleArtistId: winner.appleArtist.artistId,
        appleArtistName: winner.appleArtist.name,
        artistId: row.artistId,
        evidence: [
          "Independent MusicBrainz release-group evidence",
          evaluation.reason,
          ...winner.albumMatches.map((match) => `Exact release title: ${match.musicBrainzTitle}`),
        ],
      });
      resolved += 1;
    }
    results.push({
      artistId: row.artistId,
      reason: evaluation.reason,
      resolvedAppleArtistId: evaluation.confirmedAppleArtistId,
    });
  }
  return {
    appleRequests,
    evaluated: selected.length,
    musicBrainzRequests,
    resolved,
    results,
  };
}

export async function inventoryBoundedMusicBrainzEvidence(input: {
  limit: number;
  musicBrainzClient: Pick<MusicBrainzClient, "browseReleaseGroupsFirstPage">;
  rows: AppleIdentityResolutionBatchRow[];
}): Promise<{
  appleVerificationBlocked: true;
  evaluated: number;
  musicBrainzRequests: number;
  resolved: 0;
  results: Array<{ artistId: string; primaryReleaseGroups: number; reason: string }>;
}> {
  const selected = input.rows
    .filter((row) => row.musicBrainzId)
    .slice(0, Math.max(1, Math.min(Math.trunc(input.limit), 25)));
  const results: Array<{ artistId: string; primaryReleaseGroups: number; reason: string }> = [];
  for (const row of selected) {
    const musicBrainzId = row.musicBrainzId!;
    const groups = await input.musicBrainzClient.browseReleaseGroupsFirstPage(musicBrainzId);
    const primaryReleaseGroups = groups.filter((group) =>
      group["artist-credit"].some((credit) => credit.artist.id === musicBrainzId),
    ).length;
    results.push({
      artistId: row.artistId,
      primaryReleaseGroups,
      reason:
        "Independent MusicBrainz evidence inventoried; Apple direct verification is not configured, so no mapping was changed.",
    });
  }
  return {
    appleVerificationBlocked: true,
    evaluated: selected.length,
    musicBrainzRequests: selected.length,
    resolved: 0,
    results,
  };
}

function datesConflict(left: string, right: string): boolean {
  const leftDate = Date.parse(`${left.slice(0, 10)}T00:00:00Z`);
  const rightDate = Date.parse(`${right.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(leftDate) || !Number.isFinite(rightDate)) return false;
  return Math.abs(leftDate - rightDate) > 370 * 86_400_000;
}
