import {
  resolveAppleMusicArtistFromCatalogEvidence,
  type AppleMusicAlbumCandidate,
  type AppleMusicArtistCandidate,
  type AppleMusicMappingDecision,
  type AppleMusicSongCandidate,
} from "@radar/core";
import type { AppleMusicSong } from "@radar/providers";
import type { ItunesPilotGroundTruthRelease } from "./itunes-pilot-snapshot";

export interface AppleMusicCandidateSongEvidence {
  artist: AppleMusicArtistCandidate;
  songs: AppleMusicSong[];
}

export function resolveAppleMusicMappingFromTopSongs(
  input: {
    aliases: string[];
    candidateEvidence: AppleMusicCandidateSongEvidence[];
    canonicalName: string;
    groundTruth: ItunesPilotGroundTruthRelease[];
  },
  resolver: typeof resolveAppleMusicArtistFromCatalogEvidence = resolveAppleMusicArtistFromCatalogEvidence,
): AppleMusicMappingDecision {
  return resolver({
    aliases: input.aliases,
    candidateCatalogs: input.candidateEvidence.map((candidate) => ({
      albums: albumsFromTopSongs(candidate.songs),
      artist: candidate.artist,
      songs: candidate.songs.map(songAsCandidate),
    })),
    canonicalName: input.canonicalName,
    groundTruth: input.groundTruth,
  });
}

function albumsFromTopSongs(songs: AppleMusicSong[]): AppleMusicAlbumCandidate[] {
  const albums = new Map<string, AppleMusicAlbumCandidate>();
  for (const song of songs) {
    if (!song.albumId || !song.albumName) continue;
    const key = [song.albumId, song.albumName, song.releaseDate ?? ""].join(":");
    if (albums.has(key)) continue;
    albums.set(key, {
      albumId: song.albumId,
      artistIds: song.artistIds,
      artistName: song.artistName,
      paginationPath: song.paginationPath,
      pageNumber: song.pageNumber,
      ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
      sourceView: "album",
      title: song.albumName,
    });
  }
  return [...albums.values()];
}

function songAsCandidate(song: AppleMusicSong): AppleMusicSongCandidate {
  return {
    ...(song.albumId ? { albumId: song.albumId } : {}),
    ...(song.albumName ? { albumTitle: song.albumName } : {}),
    artistIds: song.artistIds,
    artistName: song.artistName,
    ...(song.discNumber === undefined ? {} : { discNumber: song.discNumber }),
    ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
    ...(song.isrc ? { isrc: song.isrc } : {}),
    paginationPath: song.paginationPath,
    pageNumber: song.pageNumber,
    ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
    songId: song.songId,
    title: song.title,
    ...(song.trackNumber === undefined ? {} : { trackNumber: song.trackNumber }),
  };
}
