import { normalizeAppleMusicArtworkUrl, type AppleIdentityCandidateCatalog } from "@radar/core";
import { AppleMusicClientError, type AppleMusicAlbum, type AppleMusicClient } from "./apple-music";
import type { AppleIdentityCatalogClient } from "./itunes-identity";

type IdentityAppleMusicClient = Pick<
  AppleMusicClient,
  "getArtist" | "getArtistTopSongsFirstPage" | "getArtistViewFirstPage" | "requestCount"
>;

export class AppleMusicIdentityCatalogClient implements AppleIdentityCatalogClient {
  private failures = 0;

  constructor(private readonly client: IdentityAppleMusicClient) {}

  get metrics(): { cacheHits: number; failures: number; requests: number } {
    return { cacheHits: 0, failures: this.failures, requests: this.client.requestCount };
  }

  async getArtistCatalog(appleArtistId: string): Promise<AppleIdentityCandidateCatalog> {
    if (!/^\d{1,32}$/.test(appleArtistId)) throw new Error("Apple artist ID is invalid.");
    let artist;
    try {
      artist = await this.client.getArtist(
        appleArtistId,
        undefined,
        `identity:${appleArtistId}:artist`,
      );
    } catch (error) {
      if (error instanceof AppleMusicClientError && error.status === 404) {
        return emptyCatalog(appleArtistId, "invalid");
      }
      this.failures += 1;
      throw error;
    }
    if (!artist) return emptyCatalog(appleArtistId, "unknown");

    const releases: AppleMusicAlbum[] = [];
    const songs = await this.optionalView(
      () =>
        this.client.getArtistTopSongsFirstPage(
          appleArtistId,
          `identity:${appleArtistId}:top-songs`,
        ),
      { items: [], nextPresent: false },
    );
    for (const view of ["singles", "full-albums", "appears-on-albums"] as const) {
      const page = await this.optionalView(
        () =>
          this.client.getArtistViewFirstPage(
            appleArtistId,
            view,
            undefined,
            `identity:${appleArtistId}:${view}`,
          ),
        { items: [], nextPresent: false },
      );
      releases.push(...page.items);
    }
    const uniqueReleases = dedupe(releases, (release) => release.albumId);
    const uniqueSongs = dedupe(songs.items, (song) => song.songId);
    const releaseArtwork = uniqueReleases
      .map((release) => normalizeArtwork(release.artwork?.url))
      .find((value): value is string => Boolean(value));
    return {
      appleArtistId,
      artistName: artist.name,
      artistUrl: `https://music.apple.com/${artist.sourceStorefront}/artist/${appleArtistId}`,
      ...(releaseArtwork ? { artworkUrl: releaseArtwork } : {}),
      genres: [
        ...new Set([
          ...artist.genreNames,
          ...uniqueReleases.flatMap((release) => release.genreNames),
        ]),
      ],
      labels: [
        ...new Set(
          uniqueReleases
            .map((release) => release.recordLabel)
            .filter((value): value is string => Boolean(value)),
        ),
      ],
      releases: uniqueReleases.map((release) => {
        const artworkUrl = normalizeArtwork(release.artwork?.url);
        return {
          appleReleaseId: release.albumId,
          artistIds: release.artistIds,
          artistName: release.artistName,
          ...(artworkUrl ? { artworkUrl } : {}),
          ...(release.copyright ? { copyright: release.copyright } : {}),
          ...(release.recordLabel ? { label: release.recordLabel } : {}),
          ...(release.releaseDate ? { releaseDate: release.releaseDate } : {}),
          title: release.title,
          ...(release.trackCount === undefined ? {} : { trackCount: release.trackCount }),
        };
      }),
      resourceStatus: "valid",
      songs: uniqueSongs.map((song) => ({
        ...(song.albumName ? { albumTitle: song.albumName } : {}),
        appleSongId: song.songId,
        artistIds: song.artistIds,
        artistName: song.artistName,
        ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
        title: song.title,
      })),
      source: "apple_music_api",
    };
  }

  private async optionalView<T extends { items: unknown[] }>(
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof AppleMusicClientError &&
        (error.status === 400 || error.status === 404)
      ) {
        return fallback;
      }
      this.failures += 1;
      throw error;
    }
  }
}

function emptyCatalog(
  appleArtistId: string,
  resourceStatus: "invalid" | "unknown",
): AppleIdentityCandidateCatalog {
  return {
    appleArtistId,
    artistName: `Apple artist ${appleArtistId}`,
    genres: [],
    labels: [],
    releases: [],
    resourceStatus,
    songs: [],
    source: "apple_music_api",
  };
}

function normalizeArtwork(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return normalizeAppleMusicArtworkUrl(value) ?? undefined;
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
