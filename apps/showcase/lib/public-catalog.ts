import generatedCatalog from "./generated-public-catalog.json";

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
export type PublicGenreSlug =
  | "ambient"
  | "bass"
  | "breaks"
  | "dance"
  | "downtempo"
  | "drum-and-bass"
  | "dubstep"
  | "electronic"
  | "electronica"
  | "experimental"
  | "garage"
  | "hardcore"
  | "house"
  | "industrial"
  | "techno"
  | "trance"
  | "trap";

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
  readonly contractVersion: "showcase-public-v2";
  readonly generatedAt: string;
  readonly genres: readonly PublicGenre[];
  readonly artists: readonly PublicArtist[];
  readonly releases: readonly PublicRelease[];
}

export const publicCatalog = generatedCatalog as PublicCatalogSnapshot;

const genreNameBySlug = new Map(
  publicCatalog.genres.map((genre) => [genre.slug, genre.name] as const),
);

export const getArtist = (slug: string): PublicArtist | undefined =>
  publicCatalog.artists.find((artist) => artist.slug === slug);

export const getRelease = (slug: string): PublicRelease | undefined =>
  publicCatalog.releases.find((release) => release.slug === slug);

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

export const getArtistReleases = (artistSlug: string): readonly PublicRelease[] =>
  publicCatalog.releases.filter((release) =>
    release.artistCredits.some((credit) => credit.artistSlug === artistSlug),
  );

export const getRelatedArtists = (artistSlug: string): readonly PublicArtist[] => {
  const relatedSlugs = new Set(
    getArtistReleases(artistSlug).flatMap((release) =>
      release.artistCredits.flatMap((credit) =>
        credit.artistSlug === undefined || credit.artistSlug === artistSlug
          ? []
          : [credit.artistSlug],
      ),
    ),
  );
  return [...relatedSlugs].flatMap((slug) => {
    const artist = getArtist(slug);
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
