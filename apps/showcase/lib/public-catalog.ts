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

export interface PublicProviderLinks {
  readonly spotify?: string;
  readonly appleMusic: string;
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
  readonly artistName: string;
  readonly type: PublicReleaseType;
  readonly status: PublicReleaseStatus;
  readonly releaseDate: string;
  readonly firstDiscoveredDate: string;
  readonly genres: readonly string[];
  readonly label?: string;
  readonly tracks: readonly PublicTrack[];
  readonly links: PublicProviderLinks;
  readonly artworkTone: ArtworkTone;
}

export interface PublicArtist {
  readonly publicId: `artist_${string}`;
  readonly slug: string;
  readonly name: string;
  readonly genres: readonly string[];
  readonly labelAssociations: readonly string[];
  readonly relatedArtistSlugs: readonly string[];
  readonly links: PublicProviderLinks;
  readonly artworkTone: ArtworkTone;
}

export interface PublicCatalogSnapshot {
  readonly contractVersion: "showcase-public-v1";
  readonly generatedAt: string;
  readonly artists: readonly PublicArtist[];
  readonly releases: readonly PublicRelease[];
}

const searchLinks = (name: string): PublicProviderLinks => ({
  spotify: `https://open.spotify.com/search/${encodeURIComponent(name)}`,
  appleMusic: `https://music.apple.com/us/search?term=${encodeURIComponent(name)}`,
});

const artists: readonly PublicArtist[] = [
  {
    publicId: "artist_arden_sol",
    slug: "arden-sol",
    name: "Arden Sol",
    genres: ["Progressive House", "Melodic House"],
    labelAssociations: ["Northline Recordings"],
    relatedArtistSlugs: ["mira-vale", "morrow-house"],
    links: searchLinks("Arden Sol"),
    artworkTone: "violet",
  },
  {
    publicId: "artist_mira_vale",
    slug: "mira-vale",
    name: "Mira Vale",
    genres: ["Melodic Techno", "Electronica"],
    labelAssociations: ["Liminal Works"],
    relatedArtistSlugs: ["arden-sol", "sable-circuit"],
    links: searchLinks("Mira Vale"),
    artworkTone: "rose",
  },
  {
    publicId: "artist_night_service",
    slug: "night-service",
    name: "Night Service",
    genres: ["Drum & Bass", "Jungle"],
    labelAssociations: ["Subframe"],
    relatedArtistSlugs: ["kite-theory"],
    links: searchLinks("Night Service electronic"),
    artworkTone: "cyan",
  },
  {
    publicId: "artist_kite_theory",
    slug: "kite-theory",
    name: "Kite Theory",
    genres: ["UK Garage", "Breaks"],
    labelAssociations: [],
    relatedArtistSlugs: ["night-service", "morrow-house"],
    links: searchLinks("Kite Theory electronic"),
    artworkTone: "citrus",
  },
  {
    publicId: "artist_morrow_house",
    slug: "morrow-house",
    name: "Morrow House",
    genres: ["Deep House", "Electronica"],
    labelAssociations: ["Soft Focus"],
    relatedArtistSlugs: ["arden-sol", "kite-theory"],
    links: searchLinks("Morrow House electronic"),
    artworkTone: "sand",
  },
  {
    publicId: "artist_sable_circuit",
    slug: "sable-circuit",
    name: "Sable Circuit",
    genres: ["Trance", "Techno"],
    labelAssociations: ["Liminal Works"],
    relatedArtistSlugs: ["mira-vale"],
    links: searchLinks("Sable Circuit"),
    artworkTone: "blue",
  },
];

const releases = generatedCatalog.releases as readonly PublicRelease[];

export const publicCatalog: PublicCatalogSnapshot = {
  contractVersion: "showcase-public-v1",
  generatedAt: generatedCatalog.generatedAt,
  artists,
  releases,
};

export const getArtist = (slug: string): PublicArtist | undefined =>
  publicCatalog.artists.find((artist) => artist.slug === slug);

export const getRelease = (slug: string): PublicRelease | undefined =>
  publicCatalog.releases.find((release) => release.slug === slug);

export const getReleaseArtists = (release: PublicRelease): readonly PublicArtist[] =>
  publicCatalog.artists.filter(
    (artist) =>
      artist.name.localeCompare(release.artistName, undefined, { sensitivity: "base" }) === 0,
  );

export const getArtistReleases = (artistSlug: string): readonly PublicRelease[] =>
  publicCatalog.releases.filter((release) => {
    const artist = getArtist(artistSlug);
    return (
      artist !== undefined &&
      artist.name.localeCompare(release.artistName, undefined, { sensitivity: "base" }) === 0
    );
  });

export const formatPublicDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
