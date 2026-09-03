import generatedCatalog from "./generated-public-catalog.json";
import confirmedArtistGenres from "./confirmed-artist-genres.json";
import excludedPublicArtists from "./excluded-public-artists.json";
import { parsePublicCatalogSnapshot } from "./public-catalog-schema";
import { normalizeGenreSlugs, showcaseGenreTaxonomy, type PublicGenreSlug } from "./genre-taxonomy";

export type PublicReleaseStatus = "upcoming" | "released";
export type PublicReleaseType =
  | "Single"
  | "EP"
  | "Album"
  | "Compilation"
  | "Remix"
  | "Live"
  | "Mixtape"
  | "DJ Mix"
  | "Soundtrack"
  | "Other";
export type ArtworkTone = "violet" | "citrus" | "cyan" | "rose" | "blue" | "sand";
export type { PublicGenreSlug } from "./genre-taxonomy";

export interface PublicProviderLinks {
  readonly spotify?: string;
  readonly appleMusic: string;
}

export interface PublicGenre {
  readonly name: string;
  readonly slug: PublicGenreSlug;
}

export interface PublicArtistCredit {
  readonly name: string;
  readonly artistSlug?: string;
}

export interface PublicTrack {
  readonly discNumber: number;
  readonly position: number;
  readonly title: string;
}

export interface PublicArtwork {
  readonly height: number;
  readonly source: "apple_music";
  readonly url: string;
  readonly width: number;
}

export interface PublicRelease {
  readonly publicId: `release_${string}`;
  readonly slug: string;
  readonly title: string;
  readonly artistCredits: readonly PublicArtistCredit[];
  readonly type: PublicReleaseType;
  readonly status: PublicReleaseStatus;
  readonly releaseDate: string;
  readonly firstDiscoveredDate: string;
  readonly genreSlugs: readonly PublicGenreSlug[];
  readonly label?: string;
  readonly tracks: readonly PublicTrack[];
  readonly links: PublicProviderLinks;
  readonly artwork?: PublicArtwork;
  readonly artworkTone: ArtworkTone;
}

export interface PublicArtist {
  readonly publicId: `artist_${string}`;
  readonly slug: string;
  readonly name: string;
  readonly genreSlugs: readonly PublicGenreSlug[];
  readonly labelAssociations?: readonly string[];
  readonly links: PublicProviderLinks;
  readonly artworkTone: ArtworkTone;
}

export interface PublicCatalogSnapshot {
  readonly contractVersion: "showcase-public-v3";
  readonly generatedAt: string;
  readonly genres: readonly PublicGenre[];
  readonly artists: readonly PublicArtist[];
  readonly releases: readonly PublicRelease[];
}

interface ConfirmedArtistGenreAssignment {
  readonly publicId: string;
  readonly genreSlugs: readonly string[];
}

const confirmedGenresByArtistId = new Map(
  (confirmedArtistGenres.assignments as readonly ConfirmedArtistGenreAssignment[]).map(
    (assignment) => [assignment.publicId, normalizeGenreSlugs(assignment.genreSlugs)],
  ),
);
const excludedArtistPublicIds = new Set(excludedPublicArtists.artistPublicIds);
export function buildPublicCatalogSnapshot(value: unknown): PublicCatalogSnapshot {
  const catalog = parsePublicCatalogSnapshot(value);
  const excludedArtistSlugs = new Set(
    catalog.artists.flatMap((artist) =>
      excludedArtistPublicIds.has(artist.publicId) ? [artist.slug] : [],
    ),
  );
  const normalizedArtists = catalog.artists
    .filter((artist) => !excludedArtistPublicIds.has(artist.publicId))
    .map((artist) => ({
      ...artist,
      genreSlugs:
        confirmedGenresByArtistId.get(artist.publicId) ?? normalizeGenreSlugs(artist.genreSlugs),
    })) as readonly PublicArtist[];
  const normalizedArtistBySlug = new Map(normalizedArtists.map((artist) => [artist.slug, artist]));

  return parsePublicCatalogSnapshot({
    ...catalog,
    genres: showcaseGenreTaxonomy,
    artists: normalizedArtists,
    releases: catalog.releases
      .filter(
        (release) =>
          !release.artistCredits.some(
            (credit) =>
              credit.artistSlug !== undefined && excludedArtistSlugs.has(credit.artistSlug),
          ),
      )
      .map((release) => ({
        ...release,
        genreSlugs: normalizeGenreSlugs(
          release.artistCredits.flatMap((credit) =>
            credit.artistSlug === undefined
              ? []
              : (normalizedArtistBySlug.get(credit.artistSlug)?.genreSlugs ?? []),
          ),
        ),
      })),
  });
}

export const publicCatalog = buildPublicCatalogSnapshot(generatedCatalog);

const genreNameBySlug = new Map(
  publicCatalog.genres.map((genre) => [genre.slug, genre.name] as const),
);

export const getArtist = (
  slug: string,
  catalog: PublicCatalogSnapshot = publicCatalog,
): PublicArtist | undefined => catalog.artists.find((artist) => artist.slug === slug);

export const getRelease = (
  slug: string,
  catalog: PublicCatalogSnapshot = publicCatalog,
): PublicRelease | undefined => catalog.releases.find((release) => release.slug === slug);

export const getGenreNames = (genreSlugs: readonly PublicGenreSlug[]): readonly string[] =>
  genreSlugs.flatMap((slug) => {
    const name = genreNameBySlug.get(slug);
    return name === undefined ? [] : [name];
  });

export const getArtistGenreNames = (artist: PublicArtist): readonly string[] =>
  getGenreNames(artist.genreSlugs);

export const getReleaseGenreNames = (release: PublicRelease): readonly string[] =>
  getGenreNames(release.genreSlugs);

export const formatArtistCredits = (release: PublicRelease): string =>
  release.artistCredits.map((credit) => credit.name).join(" & ");

export const getReleaseArtists = (release: PublicRelease): readonly PublicArtist[] =>
  release.artistCredits.flatMap((credit) => {
    if (credit.artistSlug === undefined) return [];
    const artist = getArtist(credit.artistSlug);
    return artist === undefined ? [] : [artist];
  });

export const getArtistReleases = (
  artistSlug: string,
  catalog: PublicCatalogSnapshot = publicCatalog,
): readonly PublicRelease[] =>
  catalog.releases.filter((release) =>
    release.artistCredits.some((credit) => credit.artistSlug === artistSlug),
  );

export const getRelatedArtists = (
  artistSlug: string,
  catalog: PublicCatalogSnapshot = publicCatalog,
): readonly PublicArtist[] => {
  const relatedSlugs = new Set(
    getArtistReleases(artistSlug, catalog).flatMap((release) =>
      release.artistCredits.flatMap((credit) =>
        credit.artistSlug === undefined || credit.artistSlug === artistSlug
          ? []
          : [credit.artistSlug],
      ),
    ),
  );
  return [...relatedSlugs].flatMap((slug) => {
    const artist = getArtist(slug, catalog);
    return artist === undefined ? [] : [artist];
  });
};

export const formatPublicDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
